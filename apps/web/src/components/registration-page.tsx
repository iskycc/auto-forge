"use client";

import Link from "next/link";
import { Alert, Card } from "antd";
import { CheckCircleOutlined, TeamOutlined, UserAddOutlined } from "@ant-design/icons";
import type { RegistrationAvailability } from "@autoforge/contracts";
import { BrandMark } from "./brand-mark";
import { ColorModeToggle } from "./color-mode-toggle";
import { RegistrationForm } from "./registration-form";
import { SessionLoginButton } from "./session-login-button";

export function RegistrationPageView({
  availability,
  returnTo,
}: {
  availability: RegistrationAvailability;
  returnTo: string;
}) {
  const enabled = availability.enabled;
  const features = enabled
    ? [
        {
          icon: UserAddOutlined,
          title: "独立本地账号",
          description: "账号保存在当前平台，不依赖 LDAP 或外部服务。",
        },
        {
          icon: CheckCircleOutlined,
          title: "创建后直接登录",
          description: "密码设置一次即可使用，无需再次修改密码。",
        },
        {
          icon: TeamOutlined,
          title: "默认项目执行操作员",
          description: "注册后可查看默认项目用例并发起执行，也可使用公开执行链接。",
        },
      ]
    : [
        {
          icon: TeamOutlined,
          title: "使用企业目录账号",
          description: "账号由 LDAP 目录统一管理，无需在平台重复注册。",
        },
        {
          icon: CheckCircleOutlined,
          title: "本地账号继续可用",
          description: "已有本地账号仍可使用原账号和密码登录。",
        },
        {
          icon: UserAddOutlined,
          title: "注册随目录配置切换",
          description: "LDAP 开启时关闭自助注册，关闭 LDAP 后自动恢复。",
        },
      ];
  return (
    <main className="min-h-screen bg-background px-8 py-6">
      <header className="mx-auto flex w-full max-w-[1080px] items-center justify-between">
        <Link
          href="/"
          className="flex items-center gap-3 text-lg font-semibold !text-foreground"
          aria-label="AutoForge 公开首页"
        >
          <BrandMark size={36} /> AutoForge
        </Link>
        <ColorModeToggle />
      </header>
      <div className="mx-auto grid w-full max-w-[1080px] grid-cols-2 items-center gap-12 py-6">
        <section aria-labelledby="registration-title" className="grid content-start gap-6">
          <div>
            <span className="text-muted-foreground">本地账号 · 内网协作</span>
            <h1
              id="registration-title"
              className="mb-4 mt-3 text-3xl font-semibold tracking-tight text-foreground"
            >
              {enabled ? "创建账号，即刻登录" : "企业目录登录已启用"}
            </h1>
            <p className="m-0 text-base leading-7 text-muted-foreground">
              {enabled
                ? "无需企业目录，使用自己设置的账号和密码加入 AutoForge。"
                : "请使用企业目录账号，或已有的本地账号登录平台。"}
            </p>
          </div>
          {features.map(({ icon: Icon, title, description }) => (
            <div key={title} className="flex items-start gap-4">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Icon className="text-lg" />
              </span>
              <div className="min-w-0">
                <h2 className="mb-1 mt-0 text-base font-medium text-foreground">{title}</h2>
                <p className="m-0 text-muted-foreground">{description}</p>
              </div>
            </div>
          ))}
        </section>
        <Card className="min-w-0" styles={{ body: { padding: 24 } }}>
          {enabled ? (
            <>
              <h2 className="mb-1 mt-0 text-xl font-semibold text-foreground">创建本地账号</h2>
              <p className="mb-4 text-muted-foreground">填写账号信息，完成后自动建立登录会话。</p>
              <RegistrationForm returnTo={returnTo} />
            </>
          ) : (
            <div className="grid gap-5">
              <h2 className="m-0 text-xl font-semibold text-foreground">自助注册已关闭</h2>
              <Alert
                type="info"
                showIcon
                title="平台已启用 LDAP"
                description="请使用企业目录账号或已有本地账号登录。无需在此创建新账号。"
              />
              <SessionLoginButton label="登录平台" className="w-full justify-center" />
              <Link href="/" className="text-center">
                返回平台首页
              </Link>
            </div>
          )}
        </Card>
      </div>
    </main>
  );
}
