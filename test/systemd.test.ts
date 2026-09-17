import { describe, expect, it } from "vitest";
import { serviceUnit } from "../src/watchers/systemd.ts";

describe("systemd service unit", () => {
  it("is a oneshot that leaves the detached serve alive when ensure-up exits", () => {
    const unit = serviceUnit();
    expect(unit).toMatch(/^Type=oneshot$/m);
    expect(unit).toMatch(/^KillMode=process$/m);
  });
});
