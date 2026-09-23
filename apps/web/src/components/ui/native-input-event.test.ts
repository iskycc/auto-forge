import { describe, expect, it } from "vitest";
import type { SyntheticEvent } from "react";
import { nativeInputEvent } from "./native-input-event";

describe("native form event compatibility", () => {
  it("preserves event methods and updates the original React propagation state", () => {
    const source = {
      target: {},
      currentTarget: {},
      defaultPrevented: false,
      stopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.stopped = true;
      },
      isDefaultPrevented() {
        return this.defaultPrevented;
      },
      isPropagationStopped() {
        return this.stopped;
      },
      persist() {},
    };
    const input = { checked: true, value: "selected-case" } as HTMLInputElement;
    const event = nativeInputEvent(source as unknown as SyntheticEvent, input);
    expect(event.target).toBe(input);
    expect(event.currentTarget).toBe(input);
    event.preventDefault();
    event.stopPropagation();
    expect(source.defaultPrevented).toBe(true);
    expect(source.stopped).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(event.isPropagationStopped()).toBe(true);
    expect(source.target).not.toBe(input);
  });
});
