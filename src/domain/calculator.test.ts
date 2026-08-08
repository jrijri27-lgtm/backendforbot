import { describe, expect, it } from "vitest";
import { calculateAutoCompound } from "./calculator.js";

describe("calculateAutoCompound", () => {
  it("applies the stabilized rate after day 30", () => {
    const projection = calculateAutoCompound(100, 31, true);
    expect(projection.points[30]?.rate).toBe(0.015);
    expect(projection.points[31]?.rate).toBe(0.008);
    expect(projection.finalBalance).toBeGreaterThan(100);
  });

  it("rejects values below the minimum", () => {
    expect(() => calculateAutoCompound(9, 10)).toThrow();
  });
});
