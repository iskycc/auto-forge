import { Badge } from "@/components/ui/badge";
import { Steps } from "antd";
import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";
import { redirect } from "next/navigation";
import { DatabaseZap, LockKeyhole, WifiOff } from "lucide-react";

import { AuthEntryForm } from "@/components/auth-entry-form";
import { PlatformInitialization } from "@/components/platform-initialization";
import { currentIdentity } from "@/lib/auth";
import { platformConfigurationView } from "@/lib/platform-configuration";
import { getPlatformServices } from "@/lib/services";
import { ColorModeToggle } from "@/components/color-mode-toggle";

export default async function SetupPage() {
  const services = await getPlatformServices();
  if (await currentIdentity()) redirect("/");
  if (!(await services.identityAccess.setupRequired())) redirect("/login");

  return (
    <main className={cn("setup-page", pageStyles["setup-page"])}>
      <div className={cn("setup-shell", pageStyles["setup-shell"])}>
        <aside className={cn("setup-showcase", pageStyles["setup-showcase"])}>
          <div className={cn("setup-brand", pageStyles["setup-brand"])}>
            <span aria-hidden="true">AF</span>
            <strong>AutoForge</strong>
          </div>
          <div className={cn("setup-showcase-copy", pageStyles["setup-showcase-copy"])}>
            <Badge className={cn("setup-offline-badge", pageStyles["setup-offline-badge"])}>
              <WifiOff size={14} /> 离线就绪
            </Badge>
            <h1>
              <span>把自动化执行</span>
              <span>能力，安全地</span>
              <span>带进内网。</span>
            </h1>
            <p>两步完成本地初始化。配置只写入数据目录，不连接遥测、CDN 或在线配置服务。</p>
          </div>
          <Steps
            className="setup-progress-list relative z-1"
            orientation="vertical"
            size="small"
            current={-1}
            items={[
              {
                title: <span className="text-foreground">选择部署模式</span>,
                content: (
                  <span className="text-muted-foreground">
                    Lite 可直接使用，Full 接入外部基础设施
                  </span>
                ),
              },
              {
                title: <span className="text-foreground">创建系统管理员</span>,
                content: (
                  <span className="text-muted-foreground">令牌使用后立即失效并从磁盘删除</span>
                ),
              },
            ]}
          />
          <div className={cn("setup-security-note", pageStyles["setup-security-note"])}>
            <LockKeyhole size={17} />
            <span>
              <strong>一次性安全引导</strong>
              <small>敏感字段不会回显，也不会进入应用日志。</small>
            </span>
          </div>
        </aside>

        <section
          className={cn("setup-workspace", pageStyles["setup-workspace"])}
          aria-labelledby="setup-page-title"
        >
          <header className={cn("setup-workspace-header", pageStyles["setup-workspace-header"])}>
            <div>
              <span className={cn("eyebrow", uiPatterns["eyebrow"])}>首次启动</span>
              <h1 id="setup-page-title">初始化控制平面</h1>
              <p>先确认运行方式，再建立第一个具备完整管理权限的本地账号。</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Badge className={cn("setup-local-status", pageStyles["setup-local-status"])}>
                <i /> 本地配置
              </Badge>
              <ColorModeToggle />
            </div>
          </header>

          <PlatformInitialization
            initial={platformConfigurationView(
              services.configurationStore.read(),
              services.configurationStore.paths.configurationFile,
            )}
          />

          <section
            className={cn(
              "setup-card setup-admin-card",
              pageStyles["setup-card"],
              pageStyles["setup-admin-card"],
            )}
            aria-labelledby="setup-title"
          >
            <div className={cn("setup-card-heading", pageStyles["setup-card-heading"])}>
              <span className={cn("setup-step-number", pageStyles["setup-step-number"])}>02</span>
              <span
                className={cn(
                  "setup-heading-icon setup-heading-icon-red",
                  pageStyles["setup-heading-icon"],
                  pageStyles["setup-heading-icon-red"],
                )}
                aria-hidden="true"
              >
                <DatabaseZap size={20} />
              </span>
              <div>
                <span className={cn("setup-kicker", pageStyles["setup-kicker"])}>访问控制</span>
                <h2 id="setup-title">创建系统管理员</h2>
                <p>
                  令牌位于 <code>config/initial-admin-token</code>，创建成功后自动删除。
                </p>
              </div>
              <Badge className={cn("setup-required-badge", pageStyles["setup-required-badge"])}>
                必需
              </Badge>
            </div>
            <AuthEntryForm mode="setup" />
          </section>

          <footer className={cn("setup-footer", pageStyles["setup-footer"])}>
            AutoForge · Offline-first control plane
          </footer>
        </section>
      </div>
    </main>
  );
}

const pageStyles = {
  "setup-admin-card":
    "[&_.auth-form]:grid-cols-2 [&_.auth-form]:pl-21 [&_.auth-form_>_label:first-child]:col-span-full [&_.auth-error]:col-span-full [&_.auth-submit]:col-span-full max-[1121px]:[&_.auth-form]:grid-cols-[1fr] max-[1121px]:[&_.auth-form]:pl-0",
  "setup-brand":
    "flex items-center relative z-1 gap-[11px] text-lg tracking-normal [&_>_span]:grid [&_>_span]:w-9.5 [&_>_span]:h-9.5 [&_>_span]:place-items-center [&_>_span]:rounded-lg [&_>_span]:bg-card [&_>_span]:shadow-xs [&_>_span]:text-sm [&_>_span]:font-semibold",
  "setup-card":
    "grid gap-5.5 mb-4 border border-solid border-border rounded-xl [padding:clamp(20px,_2.4vw,_28px)] bg-card shadow-xs",
  "setup-card-heading":
    "grid grid-cols-[30px_42px_minmax(0,_1fr)_auto] items-start gap-3 [&_h2]:[margin:3px_0_5px] [&_h2]:text-lg [&_h2]:tracking-tight [&_p]:m-0 [&_p]:text-muted-foreground [&_p]:text-xs [&_p]:leading-[1.55] [&_code]:text-info [&_code]:text-xs",
  "setup-footer": "[padding:8px_2px_0] text-muted-foreground text-xs text-center",
  "setup-heading-icon": "grid w-10 h-10 place-items-center rounded-lg",
  "setup-heading-icon-red": "bg-destructive/10 text-brand",
  "setup-kicker":
    "text-muted-foreground text-xs font-semibold tracking-normal [text-transform:uppercase]",
  "setup-local-status":
    "flex items-center [flex:0_0_auto] gap-[7px] border border-solid border-border rounded-full py-2 px-[11px] bg-card text-muted-foreground shadow-xs text-xs font-semibold [&_i]:w-[7px] [&_i]:h-[7px] [&_i]:rounded-full [&_i]:bg-success [&_i]:shadow-xs",
  "setup-offline-badge":
    "flex items-center w-fit gap-[7px] border border-solid border-border rounded-full py-[7px] px-2.5 bg-success/10 text-success text-xs font-semibold",
  "setup-page": "min-h-screen p-5.5 bg-card",
  "setup-required-badge":
    "rounded-full py-[5px] px-2 text-xs font-semibold bg-destructive/10 text-destructive",
  "setup-security-note":
    "flex items-center relative z-1 gap-[11px] mt-auto border-t border-solid border-border pt-5.5 text-foreground [&_>_span]:grid [&_>_span]:gap-1 [&_strong]:text-xs [&_small]:text-muted-foreground [&_small]:text-xs [&_small]:leading-[1.45] [&_>_svg]:text-info",
  "setup-shell":
    "grid w-[min(100%,_1280px)] min-h-[calc(100vh_-_44px)] grid-cols-[minmax(300px,_0.72fr)_minmax(620px,_1.48fr)] my-0 mx-auto overflow-hidden border border-solid border-border rounded-xl bg-card shadow-xs max-[1121px]:grid-cols-[290px_minmax(0,_1fr)]",
  "setup-showcase":
    'sticky top-5.5 flex h-[calc(100vh_-_44px)] min-h-[680px] flex-col overflow-hidden [padding:clamp(32px,_4vw,_54px)] bg-card text-foreground [&::before]:absolute [&::before]:rounded-full [&::before]:[content:""] [&::before]:pointer-events-none [&::before]:top-[-120px] [&::before]:right-[-150px] [&::before]:w-[360px] [&::before]:h-[360px] [&::before]:border [&::before]:border-solid [&::before]:border-border [&::before]:bg-card [&::after]:absolute [&::after]:rounded-full [&::after]:[content:""] [&::after]:pointer-events-none [&::after]:right-[-100px] [&::after]:bottom-[-190px] [&::after]:w-[430px] [&::after]:h-[430px] [&::after]:bg-card max-[1121px]:py-8 max-[1121px]:px-6.5',
  "setup-showcase-copy":
    "relative z-1 [margin:clamp(72px,_10vh,_118px)_0_50px] [&_h1]:max-w-[440px] [&_h1]:[margin:20px_0_16px] [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:tracking-tight [&_h1]:leading-[1.12] [&_h1]:[text-wrap:balance] [&_h1_span]:block [&_h1_span]:whitespace-nowrap [&_p]:max-w-[420px] [&_p]:m-0 [&_p]:text-muted-foreground [&_p]:text-sm [&_p]:leading-[1.8] max-[1121px]:mt-18 max-[1121px]:[&_h1]:text-3xl",
  "setup-step-number": "pt-1 text-muted-foreground font-mono text-xs font-semibold",
  "setup-workspace": "min-w-0 [padding:clamp(30px,_4vw,_56px)]",
  "setup-workspace-header":
    "flex items-start justify-between gap-7 mb-7 [&_h1]:[margin:7px_0_8px] [&_h1]:text-2xl [&_h1]:tracking-tight [&_p]:m-0 [&_p]:text-muted-foreground [&_p]:leading-[1.6]",
} as const;
