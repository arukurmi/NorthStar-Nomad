import { describe, it, expect } from "vitest";
import {
  MODE_CATEGORY_TITLE,
  PACKING_SCHEMA,
  PackingShapeError,
  itemKeyFor,
  makePackingParser,
  parsePackingList,
  type PackingList,
  type PackingShapeReason,
} from "./packing.js";
import type { JsonSchemaNode, JsonSchemaObject } from "./provider.js";

/**
 * The fixture stands in for model output, so every leaf is `unknown`: the whole
 * job of a rejection test below is to put a value there that `PackingList`
 * forbids, and a fixture typed as `PackingList` could not express one.
 */
interface RawItem {
  label?: unknown;
  qty?: unknown;
  reason?: unknown;
}
interface RawCategory {
  name?: unknown;
  items?: unknown;
}
interface RawList {
  summary?: unknown;
  categories?: unknown;
}

/**
 * A list that parses cleanly under mode "bike": four categories of three to
 * eight items, one of them carrying the dictated heading. Rebuilt on every call
 * so a mutation in one test cannot reach another.
 *
 * It also carries all four spellings of "nothing to say" in `reason` — present,
 * absent, `null` and `""` — plus one that needs trimming, because that is what
 * the vendors actually emit under a schema whose `required` names `reason`.
 */
function validList(): RawList {
  return {
    summary:
      "Coastal Karnataka in late monsoon: assume everything you pack gets soaked at least once.",
    categories: [
      {
        name: "Clothing",
        items: [
          {
            label: "Quick-dry shirts",
            qty: 3,
            reason: "Nothing cotton dries between the daily afternoon showers.",
          },
          { label: "Rain liners", qty: 1, reason: "" },
          { label: "Riding gloves", qty: 2, reason: null },
        ],
      },
      {
        name: "Gear",
        items: [
          {
            label: "Dry bag",
            qty: 2,
            reason: "The panniers on this bike are not sealed.",
          },
          { label: "Head torch", qty: 1 },
          {
            label: "Power bank",
            qty: 1,
            reason: "  Charging points are rare on the ghat sections.  ",
          },
          { label: "Bungee cords", qty: 4, reason: "" },
        ],
      },
      {
        name: "Documents",
        items: [
          { label: "Driving licence", qty: 1, reason: "" },
          { label: "Bike registration", qty: 1, reason: "" },
          { label: "Insurance printout", qty: 1, reason: "" },
        ],
      },
      {
        // U+2014 em dash, byte for byte what the prompt dictates.
        name: "Mode — Bike",
        items: [
          {
            label: "Chain lube",
            qty: 1,
            reason: "Salt air strips it in about three days.",
          },
          { label: "Puncture kit", qty: 1, reason: "" },
          { label: "Spare clutch cable", qty: 1, reason: "" },
          { label: "Tyre pressure gauge", qty: 1, reason: "" },
        ],
      },
    ],
  };
}

/** Exactly what `validList()` must parse to. Pinned in full so that a stray
 *  property, a lost trim or a changed key derivation all fail here first. */
const GOLDEN: PackingList = {
  summary:
    "Coastal Karnataka in late monsoon: assume everything you pack gets soaked at least once.",
  categories: [
    {
      name: "Clothing",
      modeCategory: false,
      items: [
        {
          itemKey: "8e466e701eb962c1",
          label: "Quick-dry shirts",
          qty: 3,
          reason: "Nothing cotton dries between the daily afternoon showers.",
        },
        { itemKey: "0f7c0b072fca3226", label: "Rain liners", qty: 1 },
        { itemKey: "7df90542e17abe99", label: "Riding gloves", qty: 2 },
      ],
    },
    {
      name: "Gear",
      modeCategory: false,
      items: [
        {
          itemKey: "09ac180080e5c707",
          label: "Dry bag",
          qty: 2,
          reason: "The panniers on this bike are not sealed.",
        },
        { itemKey: "e39bb4f43769e4a5", label: "Head torch", qty: 1 },
        {
          itemKey: "0fdbbab3a263498f",
          label: "Power bank",
          qty: 1,
          reason: "Charging points are rare on the ghat sections.",
        },
        { itemKey: "f173a88be2418dcd", label: "Bungee cords", qty: 4 },
      ],
    },
    {
      name: "Documents",
      modeCategory: false,
      items: [
        { itemKey: "0374d543ab2d21ed", label: "Driving licence", qty: 1 },
        { itemKey: "a760730bafdec6e1", label: "Bike registration", qty: 1 },
        { itemKey: "1ea340dde849bd75", label: "Insurance printout", qty: 1 },
      ],
    },
    {
      name: "Mode — Bike",
      modeCategory: true,
      items: [
        {
          itemKey: "cc0cce95e4e4da43",
          label: "Chain lube",
          qty: 1,
          reason: "Salt air strips it in about three days.",
        },
        { itemKey: "a68afd8bcd393090", label: "Puncture kit", qty: 1 },
        { itemKey: "18ce6d49cc3fdc29", label: "Spare clutch cable", qty: 1 },
        { itemKey: "4e454afb451cdb85", label: "Tyre pressure gauge", qty: 1 },
      ],
    },
  ],
};

function categoriesOf(list: RawList): unknown[] {
  return list.categories as unknown[];
}
function categoryAt(list: RawList, index: number): RawCategory {
  return categoriesOf(list)[index] as RawCategory;
}
function itemsOf(category: RawCategory): unknown[] {
  return category.items as unknown[];
}
function itemAt(list: RawList, category: number, index: number): RawItem {
  return itemsOf(categoryAt(list, category))[index] as RawItem;
}

/** A known-good list with one deviation applied. Every rejection test is that
 *  single line, so what is under test is the line itself. */
function broken(mutate: (list: RawList) => void): RawList {
  const list = validList();
  mutate(list);
  return list;
}

/**
 * Runs the parser and returns the `PackingShapeError` it threw. A clean return
 * is itself a failure — an invalid list that parses is the outcome this module
 * exists to prevent, and it would otherwise pass silently as "no error".
 */
function shapeFailure(value: unknown, mode: "bike" | "flight" | "bus" = "bike"): PackingShapeError {
  let returned: unknown;
  try {
    returned = parsePackingList(value, mode);
  } catch (err) {
    if (err instanceof PackingShapeError) return err;
    throw err;
  }
  throw new Error(
    `expected a PackingShapeError, got a parsed list instead: ${JSON.stringify(returned)}`,
  );
}

/** Reason and path together: the reason is what the adapter branches on, the
 *  path is the only thing that makes a bad vendor payload diagnosable. */
function expectRejected(
  mutate: (list: RawList) => void,
  reason: PackingShapeReason,
  path: string,
): void {
  const err = shapeFailure(broken(mutate));
  expect({ reason: err.reason, path: err.path }).toEqual({ reason, path });
}

function keysOf(list: PackingList): string[] {
  return list.categories.flatMap((category) =>
    category.items.map((item) => item.itemKey),
  );
}

describe("parsePackingList accepts", () => {
  it("parses a well-formed list and derives a key for every item", () => {
    const parsed = parsePackingList(validList(), "bike");

    expect(parsed.summary).toBe(
      "Coastal Karnataka in late monsoon: assume everything you pack gets soaked at least once.",
    );
    expect(parsed.categories).toHaveLength(4);
    for (const category of parsed.categories) {
      expect(category.items.length).toBeGreaterThanOrEqual(3);
      expect(category.items.length).toBeLessThanOrEqual(8);
      for (const item of category.items) {
        expect(item.itemKey).toMatch(/^[0-9a-f]{16}$/);
      }
    }
    // Exactly one section is expanded by default; two would be a prompt bug.
    expect(parsed.categories.filter((c) => c.modeCategory)).toHaveLength(1);
    expect(parsed.categories.find((c) => c.modeCategory)?.name).toBe(
      "Mode — Bike",
    );
    expect(parsed).toEqual(GOLDEN);
  });

  it("keeps the dictated heading byte for byte, em dash included", () => {
    // The prompt, the fixture and the constant must agree exactly: a hyphen
    // where an em dash belongs silently costs every user the expanded section.
    expect(MODE_CATEGORY_TITLE.bike).toBe("Mode — Bike");
    expect(MODE_CATEGORY_TITLE.flight).toBe("Mode — Flight");
    expect(MODE_CATEGORY_TITLE.bus).toBe("Mode — Bus");
  });

  it("trims the summary, category names and labels", () => {
    const parsed = parsePackingList(
      broken((list) => {
        list.summary = "  Pack light, wash often.\n";
        categoryAt(list, 0).name = "  Clothing  ";
        itemAt(list, 0, 0).label = "\tQuick-dry shirts ";
      }),
      "bike",
    );

    expect(parsed.summary).toBe("Pack light, wash often.");
    expect(parsed.categories[0].name).toBe("Clothing");
    expect(parsed.categories[0].items[0].label).toBe("Quick-dry shirts");
    // Trimming happens before hashing, so the key is unchanged by the padding.
    expect(parsed.categories[0].items[0].itemKey).toBe(
      GOLDEN.categories[0].items[0].itemKey,
    );
  });

  it("accepts values sitting exactly on every maximum", () => {
    const parsed = parsePackingList(
      broken((list) => {
        list.summary = "s".repeat(280);
        categoryAt(list, 0).name = "c".repeat(40);
        itemAt(list, 0, 0).label = "l".repeat(60);
        itemAt(list, 0, 0).reason = "r".repeat(160);
        itemAt(list, 0, 1).qty = 20;
        itemAt(list, 0, 2).qty = 1;
      }),
      "bike",
    );

    expect(parsed.summary).toHaveLength(280);
    expect(parsed.categories[0].name).toHaveLength(40);
    expect(parsed.categories[0].items[0].label).toHaveLength(60);
    expect(parsed.categories[0].items[0].reason).toHaveLength(160);
    // Both ends of the quantity range, either side of the untouched fixture.
    expect(parsed.categories[0].items.map((i) => i.qty)).toEqual([3, 20, 1]);
  });

  it("marks no category when the model ignored the dictated heading", () => {
    // A disobedient model costs the client an expanded-by-default section, not
    // a failed request — so this must parse, not throw.
    const parsed = parsePackingList(
      broken((list) => {
        categoryAt(list, 3).name = "Bike bits";
      }),
      "bike",
    );

    expect(parsed.categories.map((c) => c.modeCategory)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it("closes the mode over the parser rather than reading it from the payload", () => {
    // The same bytes, two parsers: only the one built for the mode in the
    // payload flags a section. This is what a forgotten post-processing step
    // on the cache-miss path would break.
    const flightList = broken((list) => {
      categoryAt(list, 3).name = "Mode — Flight";
    });

    const asFlight = makePackingParser("flight")(flightList);
    expect(asFlight.categories.map((c) => c.modeCategory)).toEqual([
      false,
      false,
      false,
      true,
    ]);

    const asBike = makePackingParser("bike")(flightList);
    expect(asBike.categories.some((c) => c.modeCategory)).toBe(false);
  });

  it("drops unknown properties at the root, on a category and on an item", () => {
    // A vendor adding a field must not take the feature down, and must not get
    // that field into `putCached` or a response body either.
    const parsed = parsePackingList(
      broken((list) => {
        (list as Record<string, unknown>).model = "gpt-5";
        (list as Record<string, unknown>).usage = { tokens: 812 };
        (categoryAt(list, 1) as Record<string, unknown>).icon = "backpack";
        (itemAt(list, 1, 0) as Record<string, unknown>).itemKey = "deadbeefdeadbeef";
        (itemAt(list, 1, 0) as Record<string, unknown>).price = 1499;
      }),
      "bike",
    );

    expect(parsed).toEqual(GOLDEN);
    expect(Object.keys(parsed)).toEqual(["summary", "categories"]);
    expect(Object.keys(parsed.categories[1])).toEqual([
      "name",
      "modeCategory",
      "items",
    ]);
    expect(Object.keys(parsed.categories[1].items[0])).toEqual([
      "itemKey",
      "label",
      "qty",
      "reason",
    ]);
    // A model-authored itemKey never becomes the primary key.
    expect(parsed.categories[1].items[0].itemKey).toBe("09ac180080e5c707");
  });

  it("returns a freshly built object rather than the input", () => {
    // Nothing is returned by reference, which is what structurally guarantees
    // the drops above cannot be undone by a later mutation of the input.
    const input = validList();
    const parsed = parsePackingList(input, "bike");

    expect(parsed as unknown).not.toBe(input);
    expect(parsed.categories as unknown).not.toBe(input.categories);
    expect(parsed.categories[0] as unknown).not.toBe(categoryAt(input, 0));
    expect(parsed.categories[0].items[0] as unknown).not.toBe(itemAt(input, 0, 0));
  });
});

describe("parsePackingList rejects", () => {
  it("throws not_object for a root that is not a plain object", () => {
    for (const value of [null, undefined, "a list", 7, true, []]) {
      const err = shapeFailure(value);
      expect({ reason: err.reason, path: err.path }).toEqual({
        reason: "not_object",
        path: "",
      });
    }
    // The root path renders as "(root)" rather than an empty gap.
    expect(shapeFailure(null).message).toBe("not_object at (root)");
  });

  it("throws not_object for a non-object element inside categories", () => {
    expectRejected(
      (list) => {
        categoriesOf(list)[2] = "Documents";
      },
      "not_object",
      "categories[2]",
    );
    expectRejected(
      (list) => {
        categoriesOf(list)[0] = null;
      },
      "not_object",
      "categories[0]",
    );
    expectRejected(
      (list) => {
        itemsOf(categoryAt(list, 1))[3] = ["Bungee cords", 4];
      },
      "not_object",
      "categories[1].items[3]",
    );
  });

  it("throws missing_field when a required key is absent", () => {
    expectRejected((list) => delete list.summary, "missing_field", "summary");
    expectRejected(
      (list) => delete list.categories,
      "missing_field",
      "categories",
    );
    expectRejected(
      (list) => delete categoryAt(list, 1).name,
      "missing_field",
      "categories[1].name",
    );
    expectRejected(
      (list) => delete categoryAt(list, 1).items,
      "missing_field",
      "categories[1].items",
    );
    expectRejected(
      (list) => delete itemAt(list, 0, 2).label,
      "missing_field",
      "categories[0].items[2].label",
    );
    expectRejected(
      (list) => delete itemAt(list, 3, 1).qty,
      "missing_field",
      "categories[3].items[1].qty",
    );
    // Explicit `undefined` is the same as absent, not a present wrong type.
    expectRejected(
      (list) => {
        list.summary = undefined;
      },
      "missing_field",
      "summary",
    );
  });

  it("throws wrong_type when a key is present with the wrong type", () => {
    expectRejected(
      (list) => {
        list.summary = 42;
      },
      "wrong_type",
      "summary",
    );
    expectRejected(
      (list) => {
        list.categories = { Clothing: [], Gear: [] };
      },
      "wrong_type",
      "categories",
    );
    expectRejected(
      (list) => {
        categoryAt(list, 2).items = { first: {} };
      },
      "wrong_type",
      "categories[2].items",
    );
    expectRejected(
      (list) => {
        itemAt(list, 0, 0).qty = "3";
      },
      "wrong_type",
      "categories[0].items[0].qty",
    );
    // A quantity of 2.5 shirts is a type error, not a range error: half a
    // checkbox has no meaning downstream.
    expectRejected(
      (list) => {
        itemAt(list, 0, 0).qty = 2.5;
      },
      "wrong_type",
      "categories[0].items[0].qty",
    );
    expectRejected(
      (list) => {
        itemAt(list, 1, 2).reason = 7;
      },
      "wrong_type",
      "categories[1].items[2].reason",
    );
  });

  it("throws empty_string for a value that is blank once trimmed", () => {
    expectRejected(
      (list) => {
        list.summary = "   ";
      },
      "empty_string",
      "summary",
    );
    expectRejected(
      (list) => {
        categoryAt(list, 2).name = "";
      },
      "empty_string",
      "categories[2].name",
    );
    expectRejected(
      (list) => {
        itemAt(list, 1, 0).label = "  ";
      },
      "empty_string",
      "categories[1].items[0].label",
    );
  });

  it("throws too_long one character past each maximum", () => {
    expectRejected(
      (list) => {
        list.summary = "s".repeat(281);
      },
      "too_long",
      "summary",
    );
    expectRejected(
      (list) => {
        categoryAt(list, 0).name = "c".repeat(41);
      },
      "too_long",
      "categories[0].name",
    );
    expectRejected(
      (list) => {
        itemAt(list, 0, 1).label = "l".repeat(61);
      },
      "too_long",
      "categories[0].items[1].label",
    );
    expectRejected(
      (list) => {
        itemAt(list, 3, 0).reason = "r".repeat(161);
      },
      "too_long",
      "categories[3].items[0].reason",
    );
  });

  it("throws out_of_range for a quantity outside 1 to 20", () => {
    expectRejected(
      (list) => {
        itemAt(list, 0, 0).qty = 0;
      },
      "out_of_range",
      "categories[0].items[0].qty",
    );
    expectRejected(
      (list) => {
        itemAt(list, 2, 1).qty = 21;
      },
      "out_of_range",
      "categories[2].items[1].qty",
    );
    expectRejected(
      (list) => {
        itemAt(list, 2, 1).qty = -3;
      },
      "out_of_range",
      "categories[2].items[1].qty",
    );
  });

  it("throws count_out_of_range for too few or too many entries", () => {
    expectRejected(
      (list) => {
        list.categories = categoriesOf(list).slice(0, 3);
      },
      "count_out_of_range",
      "categories",
    );
    expectRejected(
      (list) => {
        const cats = categoriesOf(list);
        list.categories = [...cats, ...cats].slice(0, 7);
      },
      "count_out_of_range",
      "categories",
    );
    expectRejected(
      (list) => {
        categoryAt(list, 0).items = itemsOf(categoryAt(list, 0)).slice(0, 2);
      },
      "count_out_of_range",
      "categories[0].items",
    );
    expectRejected(
      (list) => {
        const items = itemsOf(categoryAt(list, 1));
        categoryAt(list, 1).items = [...items, ...items, ...items].slice(0, 9);
      },
      "count_out_of_range",
      "categories[1].items",
    );
    // The count is checked before the elements, so an empty array reports the
    // array itself rather than dying on a missing element.
    expectRejected(
      (list) => {
        categoryAt(list, 2).items = [];
      },
      "count_out_of_range",
      "categories[2].items",
    );
  });

  it("throws duplicate_item at the second occurrence, not the first", () => {
    // Two rows sharing one key means one tick lands on a row nobody renders,
    // so this is a hard failure. The path has to point at the copy: the first
    // occurrence is the legitimate one.
    expectRejected(
      (list) => {
        itemAt(list, 1, 2).label = "Dry bag";
      },
      "duplicate_item",
      "categories[1].items[2]",
    );
    // Cosmetic drift collides too — that is the case a naive string compare
    // would wave through.
    expectRejected(
      (list) => {
        itemAt(list, 1, 3).label = "  dry-bag  ";
      },
      "duplicate_item",
      "categories[1].items[3]",
    );
  });

  it("never puts the offending value in the error message", () => {
    // Model output is untrusted text and this message ends up in an AiError
    // cause chain that a log line or a failing test will print. Echoing the
    // value there is how log injection gets in.
    const CANARY = "canary-93f1-must-not-be-logged";
    const cases: Array<[(list: RawList) => void, PackingShapeReason, string]> = [
      [
        (list) => {
          list.summary = `${CANARY} ${"x".repeat(300)}`;
        },
        "too_long",
        "summary",
      ],
      [
        (list) => {
          list.summary = { text: CANARY };
        },
        "wrong_type",
        "summary",
      ],
      [
        (list) => {
          categoryAt(list, 0).name = `${CANARY}-${CANARY}`;
        },
        "too_long",
        "categories[0].name",
      ],
      [
        (list) => {
          itemAt(list, 1, 1).label = `${CANARY} ${CANARY} ${CANARY}`;
        },
        "too_long",
        "categories[1].items[1].label",
      ],
      [
        (list) => {
          itemAt(list, 1, 1).qty = CANARY;
        },
        "wrong_type",
        "categories[1].items[1].qty",
      ],
      [
        (list) => {
          itemAt(list, 3, 2).reason = CANARY.repeat(10);
        },
        "too_long",
        "categories[3].items[2].reason",
      ],
    ];

    for (const [mutate, reason, path] of cases) {
      const err = shapeFailure(broken(mutate));
      expect({ reason: err.reason, path: err.path }).toEqual({ reason, path });
      expect(err.message).not.toContain(CANARY);
      expect(err.message).not.toContain("canary");
      expect(String(err)).not.toContain(CANARY);
      // Structure only, and enough of it to debug from.
      expect(err.message).toBe(`${reason} at ${path}`);
    }

    // A canary supplied as the whole root leaks nowhere either.
    const rootErr = shapeFailure(CANARY);
    expect(rootErr.message).not.toContain(CANARY);
    expect(rootErr.message).toBe("not_object at (root)");
    expect(rootErr).toBeInstanceOf(PackingShapeError);
    expect(rootErr.name).toBe("PackingShapeError");
  });
});

describe("itemKeyFor", () => {
  it("collapses cosmetic drift in a label to one key", () => {
    // Regeneration rewords labels; a tick made last week has to survive it.
    const expected = itemKeyFor("Clothing", "Rain liners");
    for (const label of [
      "Rain liners",
      "rain liners",
      "Rain  liners",
      "Rain-liners",
      "  RAIN LINERS  ",
      "RAIN — LINERS",
    ]) {
      expect(itemKeyFor("Clothing", label)).toBe(expected);
    }
    // And in the category name, which is part of the same input.
    expect(itemKeyFor("clothing", "Rain liners")).toBe(expected);
  });

  it("pins one key value as a regression anchor", () => {
    // Changing the slug or the hash orphans every tick already in the
    // database, so the derivation is frozen here deliberately.
    expect(itemKeyFor("Clothing", "Rain liners")).toBe("0f7c0b072fca3226");
  });

  it("separates the same label under two different categories", () => {
    // "Gloves" under Clothing and under Mode — Bike are two checkboxes.
    expect(itemKeyFor("Gear", "Rain liners")).not.toBe(
      itemKeyFor("Clothing", "Rain liners"),
    );
    expect(itemKeyFor("Mode — Bike", "Gloves")).not.toBe(
      itemKeyFor("Clothing", "Gloves"),
    );
  });

  it("always produces sixteen lowercase hex characters", () => {
    for (const [category, label] of [
      ["Clothing", "Rain liners"],
      ["Mode — Bike", "Spare clutch cable"],
      ["Documents", "पासपोर्ट"],
      ["!!!", "???"],
      ["", ""],
    ]) {
      expect(itemKeyFor(category, label)).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it("survives the model reordering the whole list", () => {
    // An index-based key would change on every regeneration; these must not.
    const forward = parsePackingList(validList(), "bike");
    const shuffledInput = validList();
    const categories = categoriesOf(shuffledInput).reverse();
    for (const category of categories) {
      itemsOf(category as RawCategory).reverse();
    }
    shuffledInput.categories = categories;
    const shuffled = parsePackingList(shuffledInput, "bike");

    expect(keysOf(shuffled)).not.toEqual(keysOf(forward));
    expect(new Set(keysOf(shuffled))).toEqual(new Set(keysOf(forward)));
    // Fourteen items, fourteen distinct keys.
    expect(new Set(keysOf(forward)).size).toBe(14);
  });
});

/** Every object node reachable from the schema, with its path, so the walk
 *  covers nodes added later rather than the three that exist today. */
function forEachObjectNode(
  node: JsonSchemaNode,
  path: string,
  visit: (object: JsonSchemaObject, path: string) => void,
): void {
  if (node.type === "object") {
    visit(node, path);
    for (const [key, child] of Object.entries(node.properties)) {
      forEachObjectNode(child, `${path}.${key}`, visit);
    }
    return;
  }
  if (node.type === "array") {
    forEachObjectNode(node.items, `${path}[]`, visit);
  }
}

describe("PACKING_SCHEMA", () => {
  it("names every property in required on every object node", () => {
    // OpenAI strict mode rejects the whole request when `required` misses a
    // key, and adding a property without updating `required` is a one-line
    // change nobody notices until a vendor 400s in production.
    const visited: string[] = [];
    forEachObjectNode(PACKING_SCHEMA, "", (object, path) => {
      const where = path === "" ? "(root)" : path;
      visited.push(where);
      expect(object.additionalProperties, `additionalProperties at ${where}`).toBe(
        false,
      );
      expect([...(object.required ?? [])].sort(), `required at ${where}`).toEqual(
        Object.keys(object.properties).sort(),
      );
    });

    expect(visited).toEqual([
      "(root)",
      ".categories[]",
      ".categories[].items[]",
    ]);
  });

  it("keeps the server-derived fields out of the schema entirely", () => {
    // `modeCategory` and `itemKey` are computed here. Offering `itemKey` to the
    // model would let model-authored text become a primary key.
    const serialised = JSON.stringify(PACKING_SCHEMA);
    expect(serialised).not.toContain("itemKey");
    expect(serialised).not.toContain("modeCategory");
  });
});
