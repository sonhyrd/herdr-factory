// The factory review verdict a PR watch hands to its run (issue #86): marker parsing and the trigger rule.
import { describe, expect, it } from "vitest";
import { parseVerdict, wantsFix } from "../src/core/review-verdict.ts";

describe("parseVerdict / wantsFix", () => {
  it("reads any brand's markers (and the legacy one) and counts the numbered findings", () => {
    const v = parseVerdict(
      ["<!-- hf:review K -->", "hf-review-verdict: changes-requested", "hf-review-round: 2", "hf-review-head: abc1234def", "", "- [ ] 1. **must-fix** `a.ts:1` — x", "- [x] 2. **should-fix** — y", "3. **nit** z", "not a finding: must-fix"].join("\n"),
    );
    expect(v).toEqual({ verdicts: ["changes-requested"], round: 2, head: "abc1234def", must: 1, should: 1, nit: 1 });
    expect(parseVerdict("herdr-factory-review-verdict: clean")?.verdicts).toEqual(["clean"]);
    expect(parseVerdict("herdr-review: clean")?.verdicts).toEqual(["clean"]);
    expect(parseVerdict("LGTM, no markers here")).toBeNull();
  });

  it("wants a fix for changes-requested or a should-fix under clean — never unchanged, nits-only, or needs-human", () => {
    const w = (body: string) => wantsFix(parseVerdict(body)!);
    expect(w("hf-review-verdict: changes-requested")).toBe(true);
    expect(w("hf-review-verdict: clean\n- [ ] 1. **should-fix** y")).toBe(true);
    expect(w("hf-review-verdict: clean\n- [ ] 1. **nit** z")).toBe(false);
    expect(w("hf-review-verdict: unchanged")).toBe(false);
    expect(w("hf-review-verdict: changes-requested\nhf-review-verdict: needs-human")).toBe(false);
  });
});
