package main

import (
	"context"
	"embed"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"time"

	"github.com/iskycc/auto-forge/apps/log-archive-viewer/internal/archive"
	"github.com/iskycc/auto-forge/apps/log-archive-viewer/internal/server"
)

//go:embed assets/*
var bundledAssets embed.FS

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "AutoForge 日志归档：", err)
		os.Exit(1)
	}
}
func run() error {
	runtime.GOMAXPROCS(min(4, runtime.GOMAXPROCS(0)))
	verify := flag.String("verify", "", "校验归档 ZIP 文件")
	pack := flag.String("pack", "", "压缩并校验已生成的归档目录")
	output := flag.String("output", "", "归档 ZIP 输出路径")
	index := flag.String("index", "", "ZIP 范围索引输出路径")
	directory := flag.String("directory", "", "已解压归档目录（默认程序所在目录）")
	noBrowser := flag.Bool("no-browser", false, "只显示本地地址，不打开浏览器")
	address := flag.String("listen", "127.0.0.1:0", "本地监听地址，仅支持 IPv4 loopback")
	workerLease := flag.String("worker-lease", "", "内部归档工作器租约文件")
	workerParent := flag.Int("worker-parent", 0, "内部归档工作器进程 ID")
	flag.Parse()
	stopLease := watchWorkerLease(*workerLease, *workerParent)
	defer stopLease()
	if *verify != "" {
		return archive.Verify(*verify)
	}
	if *pack != "" {
		if *output == "" || *index == "" {
			return errors.New("--pack requires --output and --index")
		}
		return archive.Pack(*pack, *output, *index)
	}
	if *directory == "" {
		executable, err := os.Executable()
		if err != nil {
			return err
		}
		*directory = filepath.Dir(executable)
	}
	reader, err := archive.Open(archive.Directory{Root: *directory})
	if err != nil {
		return err
	}
	assets, err := fs.Sub(bundledAssets, "assets")
	if err != nil {
		return err
	}
	if err = validateViewerAssets(assets); err != nil {
		return err
	}
	host, _, err := net.SplitHostPort(*address)
	if err != nil || host != "127.0.0.1" {
		return errors.New("viewer must listen on 127.0.0.1")
	}
	listener, err := net.Listen("tcp4", *address)
	if err != nil {
		return err
	}
	defer listener.Close()
	localURL := "http://" + listener.Addr().String() + "/"
	fmt.Println("AutoForge 离线日志：", localURL)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	httpServer := &http.Server{Handler: server.New(reader, assets, listener.Addr().String()), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16 * 1024}
	failures := make(chan error, 1)
	go func() { failures <- httpServer.Serve(listener) }()
	if !*noBrowser {
		if err = launchBrowser(localURL); err != nil {
			fmt.Fprintln(os.Stderr, "无法自动打开浏览器，请访问上面的本地地址：", err)
		}
	}
	select {
	case err = <-failures:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return httpServer.Shutdown(shutdown)
}
func launchBrowser(url string) error {
	var command *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		command = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		command = exec.Command("open", url)
	default:
		command = exec.Command("xdg-open", url)
	}
	if err := command.Start(); err != nil {
		return err
	}
	return command.Wait()
}

// A partial UI bundle must fail explicitly rather than launch an unstyled page.
func validateViewerAssets(assets fs.FS) error {
	for _, name := range []string{"index.html", "viewer.js", "viewer.css", "licenses.txt"} {
		metadata, err := fs.Stat(assets, name)
		if err != nil {
			return fmt.Errorf("offline viewer asset %s was not embedded: %w", name, err)
		}
		if metadata.IsDir() || metadata.Size() == 0 {
			return fmt.Errorf("offline viewer asset %s is empty", name)
		}
	}
	return nil
}
