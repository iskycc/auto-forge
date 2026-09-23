import type { SyntheticEvent } from "react";

/** Keep React propagation on the original event while exposing the native form field. */
export function nativeInputEvent<Event extends SyntheticEvent>(
  event: Event,
  input: HTMLInputElement,
): Event & {
  target: HTMLInputElement;
  currentTarget: HTMLInputElement;
} {
  return Object.create(event, {
    target: { value: input },
    currentTarget: { value: input },
    preventDefault: { value: event.preventDefault.bind(event) },
    stopPropagation: { value: event.stopPropagation.bind(event) },
    persist: { value: event.persist.bind(event) },
  });
}
