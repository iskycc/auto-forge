package control

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/iskycc/auto-forge/apps/runner-agent/internal/buildinfo"
	"github.com/iskycc/auto-forge/apps/runner-agent/internal/config"
	"github.com/iskycc/auto-forge/apps/runner-agent/internal/metrics"
	"github.com/iskycc/auto-forge/apps/runner-agent/internal/terminal"
)

// isCredentialRejected reports whether the control plane permanently rejected
// the stored runner credential (deregistered, revoked, or unknown runner).
// Disabled runners return RUNNER_DISABLED and must keep their identity.
func isCredentialRejected(err error) bool {
	var problem *APIError
	if !errors.As(err, &problem) {
		return false
	}
	return problem.Code == "RUNNER_AUTH_REJECTED"
}

func Run(ctx context.Context, configuration config.Config, info buildinfo.Info, diagnostics io.Writer) error {
	if _, err := config.CheckLocalEnvironment(configuration); err != nil {
		return err
	}
	client, err := NewClient(configuration)
	if err != nil {
		return err
	}
	defer client.Close()
	store := NewIdentityStore(configuration.DataDirectory)
	identity, exists, err := store.Load()
	if err != nil {
		return err
	}
	interval := 15 * time.Second
	if !exists {
		if configuration.BootstrapToken == "" {
			return errors.New("runner is not registered and the bootstrap token is missing")
		}
		identity, interval, err = client.Register(ctx, configuration, info)
		if err != nil {
			return err
		}
		if err := store.Save(identity); err != nil {
			return err
		}
		_ = os.Unsetenv("AUTOFORGE_AGENT_BOOTSTRAP_TOKEN")
		if configuration.ConfigurationFile != "" {
			if err := config.ConsumeBootstrapToken(configuration.ConfigurationFile); err != nil {
				return fmt.Errorf("consume bootstrap token after registration: %w", err)
			}
		}
		configuration.BootstrapToken = ""
		configuration.HasBootstrap = false
		fmt.Fprintf(diagnostics, "runner registered: %s\n", identity.RunnerID)
	} else if identity.ServerURL != configuration.ServerURL.String() {
		return errors.New("stored runner identity belongs to a different control-plane URL")
	} else {
		// 控制面可能在 Agent 离线期间注销了该执行机（运维重新安装时旧身份文件仍残留在数据目录）。
		// 必须先验证凭据仍然有效，再消费 bootstrap token；否则旧凭据被拒绝后 Agent 将既无法
		// 认证也无法重新注册。验证失败且凭据被永久拒绝时，删除本地身份并用新的 bootstrap
		// token 重新注册。
		identity, interval, err = ensureIdentityAccepted(ctx, client, store, identity, configuration, info, diagnostics)
		if err != nil {
			return err
		}
		if configuration.ConfigurationFile != "" && configuration.HasBootstrap {
			if err := config.ConsumeBootstrapToken(configuration.ConfigurationFile); err != nil {
				return fmt.Errorf("consume bootstrap token from registered runner: %w", err)
			}
			configuration.BootstrapToken = ""
			configuration.HasBootstrap = false
		}
	}

	var terminalConnector *terminalConnector
	if configuration.Terminal.Enabled {
		terminalManager := terminal.NewManager(ctx, terminal.Configuration{
			Shell:           configuration.Terminal.Shell,
			WorkDirectory:   configuration.Terminal.WorkDirectory,
			MaxSessions:     configuration.Terminal.MaxSessions,
			MaximumDuration: configuration.Terminal.MaximumDuration,
		})
		defer terminalManager.CloseAll()
		terminalConnector = newTerminalConnector(client, terminalManager, diagnostics)
		go terminalConnector.Run(ctx)
	}
	resourceCollector := metrics.NewCollector()
	supervisor := newAttemptSupervisor(client, identity, configuration, diagnostics)
	if err := supervisor.Start(ctx); err != nil {
		return fmt.Errorf("start assignment supervisor: %w", err)
	}
	defer supervisor.Close()

	for {
		var resourceSnapshot *metrics.Snapshot
		collected, metricsErr := resourceCollector.Collect()
		if metricsErr != nil {
			fmt.Fprintf(diagnostics, "resource metrics unavailable: %v\n", metricsErr)
		} else {
			resourceSnapshot = &collected
		}
		response, heartbeatErr := client.Heartbeat(
			ctx,
			identity,
			configuration,
			info,
			supervisor.BusySlots(),
			resourceSnapshot,
			supervisor.CachedBatchIDs(),
		)
		if heartbeatErr != nil {
			if ctx.Err() != nil {
				return nil
			}
			fmt.Fprintf(diagnostics, "heartbeat failed: %v\n", heartbeatErr)
		} else {
			supervisor.ApplyClosedBatchIDs(response.ClosedBatchIDs)
			interval = heartbeatInterval(response.HeartbeatIntervalSecond)
			if terminalConnector != nil {
				terminalConnector.UpdateToken(response.TerminalConnectionToken)
			}
			if supervisor.SetDraining(response.Draining) {
				if response.Draining {
					fmt.Fprintln(diagnostics, "assignment claiming paused by the control plane")
				} else {
					fmt.Fprintln(diagnostics, "assignment claiming resumed by the control plane")
				}
			}
			if response.RotateCredential {
				rotated, rotationErr := client.RotateCredential(ctx, identity)
				if rotationErr != nil {
					fmt.Fprintf(diagnostics, "credential rotation failed: %v\n", rotationErr)
				} else if persistErr := persistRotatedIdentity(ctx, store, rotated, diagnostics); persistErr != nil {
					return persistErr
				} else {
					identity = rotated
					supervisor.UpdateIdentity(rotated)
					fmt.Fprintln(diagnostics, "runner credential rotated")
				}
			}
		}
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return nil
		case <-timer.C:
		}
	}
}

// ensureIdentityAccepted verifies that the control plane still accepts the
// stored credential before the Agent enters its main loop. When the control
// plane permanently rejects the credential (e.g. the runner was deregistered
// while the Agent was offline and then reinstalled), the local identity is
// discarded and the Agent re-registers with a fresh bootstrap token when one
// is available.
func ensureIdentityAccepted(
	ctx context.Context,
	client *Client,
	store IdentityStore,
	identity Identity,
	configuration config.Config,
	info buildinfo.Info,
	diagnostics io.Writer,
) (Identity, time.Duration, error) {
	heartbeat, heartbeatErr := client.Heartbeat(ctx, identity, configuration, info, 0, nil, nil)
	if heartbeatErr == nil {
		return identity, heartbeatInterval(heartbeat.HeartbeatIntervalSecond), nil
	}
	if !isCredentialRejected(heartbeatErr) {
		return identity, 15 * time.Second, nil
	}
	fmt.Fprintf(diagnostics, "stored runner credential was rejected by the control plane: %v\n", heartbeatErr)
	if configuration.BootstrapToken == "" {
		return identity, 0, fmt.Errorf("runner credential is no longer valid and no bootstrap token is available for re-registration")
	}
	if err := store.Remove(); err != nil {
		return identity, 0, fmt.Errorf("remove rejected runner identity: %w", err)
	}
	reregistered, interval, err := client.Register(ctx, configuration, info)
	if err != nil {
		return identity, 0, err
	}
	if err := store.Save(reregistered); err != nil {
		return identity, 0, err
	}
	_ = os.Unsetenv("AUTOFORGE_AGENT_BOOTSTRAP_TOKEN")
	fmt.Fprintf(diagnostics, "runner re-registered: %s\n", reregistered.RunnerID)
	return reregistered, interval, nil
}

func persistRotatedIdentity(ctx context.Context, store IdentityStore, identity Identity, diagnostics io.Writer) error {
	backoff := time.Second
	for {
		if err := store.Save(identity); err == nil {
			return nil
		} else {
			fmt.Fprintf(diagnostics, "persist rotated runner identity: %v; retrying\n", err)
		}
		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return fmt.Errorf("persist rotated runner identity: %w", ctx.Err())
		case <-timer.C:
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}
