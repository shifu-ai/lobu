import { describe, expect, test } from "bun:test";
import {
  buildIndustrySpecs,
  extractNaicsRows,
  parentCode,
  parseSharedStrings,
  parseSheet,
  synthesizeIntermediates,
} from "../industries.ts";

// Two leaf 6-digit codes from the same 2-digit sector. Enough to exercise
// hierarchy synthesis and parent_id resolution.
const FIXTURE_TABLE: string[][] = [
  ["NAICS Code", "NAICS Title"], // header row — extractNaicsRows drops it
  ["541512", "Computer Systems Design Services"],
  ["541511", "Custom Computer Programming Services"],
];

describe("parseSharedStrings", () => {
  test("decodes <si><t>...</t></si> entries in order", () => {
    const xml =
      '<sst><si><t>Alpha</t></si><si><t xml:space="preserve">Beta </t></si><si><t>R&amp;D</t></si></sst>';
    expect(parseSharedStrings(xml)).toEqual(["Alpha", "Beta ", "R&D"]);
  });

  test("joins multiple <t> children inside one <si>", () => {
    const xml = "<sst><si><t>A</t><t>B</t></si></sst>";
    expect(parseSharedStrings(xml)).toEqual(["AB"]);
  });
});

describe("parseSheet", () => {
  test("extracts cells, sorting by column letter, resolving shared strings", () => {
    const shared = ["Code", "Title", "Computer Systems Design Services"];
    const xml = `
      <worksheet><sheetData>
        <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
        <row r="2"><c r="A2"><v>541512</v></c><c r="B2" t="s"><v>2</v></c></row>
      </sheetData></worksheet>`;
    expect(parseSheet(xml, shared)).toEqual([
      ["Code", "Title"],
      ["541512", "Computer Systems Design Services"],
    ]);
  });
});

describe("extractNaicsRows", () => {
  test("drops header / non-numeric / empty rows", () => {
    const rows = extractNaicsRows(FIXTURE_TABLE);
    expect(rows).toEqual([
      { code: "541512", title: "Computer Systems Design Services" },
      { code: "541511", title: "Custom Computer Programming Services" },
    ]);
  });
});

describe("synthesizeIntermediates", () => {
  test("adds 2/3/4/5-digit parents for every leaf", () => {
    const out = synthesizeIntermediates([
      { code: "541512", title: "Computer Systems Design Services" },
    ]);
    expect(out.map((r) => r.code).sort()).toEqual([
      "54",
      "541",
      "5415",
      "54151",
      "541512",
    ]);
  });

  test("does not re-synthesize parents that already exist", () => {
    const out = synthesizeIntermediates([
      { code: "54", title: "Professional, Scientific, and Technical Services" },
      { code: "541512", title: "Computer Systems Design Services" },
    ]);
    const fiftyFour = out.filter((r) => r.code === "54");
    expect(fiftyFour).toHaveLength(1);
    expect(fiftyFour[0]?.title).toBe(
      "Professional, Scientific, and Technical Services"
    );
  });
});

describe("parentCode", () => {
  test("walks up the NAICS hierarchy by trimming the last digit", () => {
    expect(parentCode("541512")).toBe("54151");
    expect(parentCode("54151")).toBe("5415");
    expect(parentCode("54")).toBeNull();
  });
});

describe("buildIndustrySpecs", () => {
  test("emits one spec per row, with NAICS metadata + parent_id when available", () => {
    const rows = synthesizeIntermediates(extractNaicsRows(FIXTURE_TABLE));
    const parentIdByCode = new Map([
      ["54", 1],
      ["541", 2],
      ["5415", 3],
      ["54151", 4],
    ]);
    const specs = buildIndustrySpecs(rows, parentIdByCode);

    const top = specs.find((s) => s.canonicalKey === "54")!;
    expect(top.parent_id).toBeUndefined();
    expect(top.metadata).toMatchObject({
      code: "54",
      taxonomy_source: "NAICS",
    });

    const six = specs.find((s) => s.canonicalKey === "541512")!;
    expect(six.parent_id).toBe(4);
    expect(six.slug).toBe("naics-541512");
  });

  test("sorts shortest-first so parents land before children in single-pass mode", () => {
    const rows = synthesizeIntermediates(extractNaicsRows(FIXTURE_TABLE));
    const specs = buildIndustrySpecs(rows, new Map());
    const order = specs.map((s) => s.canonicalKey);
    expect(order[0]?.length).toBe(2); // 2-digit sector first
  });
});
