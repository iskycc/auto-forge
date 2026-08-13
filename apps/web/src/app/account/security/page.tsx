import { redirect } from "next/navigation";

import { AccountSecurity } from "@/components/account-security";
import { currentIdentity } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export const dynamic = "force-dynamic";

export default async function AccountSecurityPage() {
  const identity = await currentIdentity();
  if (!identity) redirect("/login");
  const sessions = await (await getPlatformServices()).identityAccess.listSessions(identity);

  return (
    <section className="page-stack narrow-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Account Security</p>
          <h1>账号安全</h1>
          <p>修改本地密码并管理当前账号的登录会话。</p>
        </div>
      </header>
      <AccountSecurity identity={identity} sessions={sessions} />
    </section>
  );
}
