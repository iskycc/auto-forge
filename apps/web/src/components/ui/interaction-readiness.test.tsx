import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Button } from "./button";
import { Tabs } from "./tabs";

it("disables client actions in the server response until handlers are attached", () => {
  const html = renderToStaticMarkup(<Button onClick={() => undefined}>创建用户</Button>);
  expect(html).toMatch(/<button[^>]+disabled=""/u);
});

it("marks server-rendered tabs as unavailable until their navigation handlers are attached", () => {
  const html = renderToStaticMarkup(
    <Tabs
      label="管理模块"
      value="users"
      items={[
        { key: "users", label: "用户管理" },
        { key: "roles", label: "角色权限" },
      ]}
      onChange={() => undefined}
    />,
  );
  expect(html.match(/aria-disabled="true"/gu)).toHaveLength(2);
});
