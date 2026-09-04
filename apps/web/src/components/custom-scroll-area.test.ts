import { describe, expect, it } from "vitest";

import { calculateScrollMetrics } from "./custom-scroll-area";

describe("custom scroll area metrics", () => {
  it("maps viewport scroll progress onto a bounded custom thumb", () => {
    expect(
      calculateScrollMetrics({
        clientHeight: 400,
        scrollHeight: 1_000,
        scrollTop: 300,
        trackHeight: 360,
      }),
    ).toEqual({
      scrollable: true,
      scrollTop: 300,
      maximumScrollTop: 600,
      thumbHeight: 144,
      thumbTop: 108,
    });
  });

  it("hides the custom scrollbar when all content fits", () => {
    expect(
      calculateScrollMetrics({
        clientHeight: 400,
        scrollHeight: 300,
        scrollTop: 0,
        trackHeight: 360,
      }),
    ).toMatchObject({ scrollable: false, maximumScrollTop: 0 });
  });
});
