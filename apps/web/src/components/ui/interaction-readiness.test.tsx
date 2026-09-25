import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Button } from "./button";
import { Tabs } from "./tabs";
import { ChoiceInput } from "./choice-input";
import { Input } from "./input";
import { Textarea } from "./textarea";
import { NumberInput } from "./number-input";
import { SuggestionInput } from "./suggestion-input";
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
    <Input key="password" type="password" />,
    <Textarea key="textarea" />,
    <NumberInput key="number" />,
    <SuggestionInput key="suggestion" suggestions={["UTC"]} />,
    <Select key="multiple" multiple>
      <option value="reader">只读</option>
    </Select>,
    <Select key="select">
      <option value="first">First</option>
    </Select>,
  ]) {
    const html = renderToStaticMarkup(control);
    expect(html).toMatch(/<(?:input|textarea|select)[^>]+disabled=""/u);
  }
});

it("keeps passwords masked in the server response", () => {
  const html = renderToStaticMarkup(<Input type="password" defaultValue="fixture-password" />);
  expect(html).toMatch(/<input[^>]+type="password"/u);
  expect(html).not.toMatch(/<input[^>]+type="text"/u);
});

it("renders number constraints and initial values in the hidden form bridge", () => {
  const html = renderToStaticMarkup(
    <NumberInput name="concurrency" defaultValue="2.5" min={1} max={10} step={0.5} required />,
  );
  expect(html).toContain("ant-input-number");
  const bridge = html.match(/<input[^>]+aria-hidden="true"[^>]*>/u)?.[0];
  for (const attribute of [
    'name="concurrency"',
    'min="1"',
    'max="10"',
    'step="0.5"',
    'required=""',
    'value="2.5"',
  ])
    expect(bridge).toContain(attribute);
});

it("keeps all selected options in a hidden multiple form field", () => {
  const html = renderToStaticMarkup(
    <Select name="roles" multiple defaultValue={["reader", "editor"]}>
      <option value="reader">只读</option>
      <option value="editor">编辑</option>
      <option value="admin">管理</option>
    </Select>,
  );
  expect(html).toMatch(/<select[^>]+aria-hidden="true"[^>]+multiple=""/u);
  expect(html).toMatch(/<option value="reader" selected=""/u);
  expect(html).toMatch(/<option value="editor" selected=""/u);
  expect(html).toMatch(/<option value="admin">/u);
  expect(html).toContain("ant-select-multiple");
});
