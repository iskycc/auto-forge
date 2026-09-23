import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Button } from "./button";
import { Tabs } from "./tabs";
import { ChoiceInput } from "./choice-input";
import { Input } from "./input";
import { Textarea } from "./textarea";
import { Select } from "./native-select-bridge";

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

it("keeps form controls disabled while hydration could still discard their first change", () => {
  for (const control of [
    <ChoiceInput key="checkbox" type="checkbox" />,
    <ChoiceInput key="radio" type="radio" />,
    <Input key="text" />,
    <Textarea key="textarea" />,
    <Select key="select">
      <option value="first">First</option>
    </Select>,
  ]) {
    const html = renderToStaticMarkup(control);
    expect(html).toMatch(/<(?:input|textarea|select)[^>]+disabled=""/u);
  }
});
