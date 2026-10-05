/**
 * The entity registry's own consistency.
 *
 * The registry is the contract between every app and the one transfer engine,
 * so a mistake here is not a bug in one screen — it is a screen that offers an
 * action the route will refuse, or a field nobody can map. These are cheap,
 * total checks over the whole table, and they run on every `npm test`.
 *
 * The adapter-coverage half lives in the integration suite, because it needs
 * the adapters to be registered (which needs the database module).
 */
import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, roleBasePermissions } from "../permissions";
import {
  DATA_ENTITIES,
  defaultExportFields,
  entitiesForIndustry,
  entitiesForModule,
  findEntity,
  findField,
  importableFields,
  isImportable,
  requireEntity,
} from "./registry";
import { DATA_MODULES, FIELD_TYPES } from "./types";

describe("entity keys", () => {
  it("are unique", () => {
    const keys = DATA_ENTITIES.map((entity) => entity.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("are `module.entity`, which is the shape the migration's CHECK enforces", () => {
    // `data_import_jobs.entity_key` carries a CHECK on this pattern, so a key
    // that does not match it is a row the database refuses at runtime.
    for (const entity of DATA_ENTITIES) {
      expect(entity.key, `${entity.key} is not module.entity`).toMatch(
        /^[a-z0-9_]+\.[a-z0-9_]+$/,
      );
    }
  });

  it("name a module the engine knows", () => {
    for (const entity of DATA_ENTITIES) {
      expect(DATA_MODULES).toContain(entity.module);
      // And the key's own prefix agrees with the declared module, so a reader
      // can tell where an entity belongs from its key alone.
      expect(entity.key.split(".")[0]).toBe(entity.module);
    }
  });

  it("covers every app the platform has", () => {
    for (const module of DATA_MODULES) {
      expect(entitiesForModule(module).length, `${module} has no entities`).toBeGreaterThan(0);
    }
  });
});

describe("fields", () => {
  it("are uniquely keyed within an entity", () => {
    for (const entity of DATA_ENTITIES) {
      const keys = entity.fields.map((field) => field.key);
      expect(new Set(keys).size, `${entity.key} has duplicate field keys`).toBe(keys.length);
    }
  });

  it("declare a known type", () => {
    for (const entity of DATA_ENTITIES) {
      for (const field of entity.fields) {
        expect(FIELD_TYPES, `${entity.key}.${field.key}`).toContain(field.type);
      }
    }
  });

  it("carry a Persian label, because the label is the column header", () => {
    for (const entity of DATA_ENTITIES) {
      for (const field of entity.fields) {
        expect(field.label.trim().length, `${entity.key}.${field.key} has no label`).toBeGreaterThan(
          0,
        );
      }
    }
  });

  it("give every enum field its options", () => {
    for (const entity of DATA_ENTITIES) {
      for (const field of entity.fields) {
        if (field.type !== "enum") continue;
        expect(field.options?.length, `${entity.key}.${field.key} is an enum with no options`)
          .toBeGreaterThan(0);
        for (const option of field.options ?? []) {
          expect(option.label.trim().length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("give every reference field a relation, and vice versa", () => {
    for (const entity of DATA_ENTITIES) {
      for (const field of entity.fields) {
        if (field.type === "reference") {
          expect(field.relation, `${entity.key}.${field.key} is a reference with no relation`)
            .toBeTruthy();
        }
        if (field.relation) {
          expect(field.type, `${entity.key}.${field.key} has a relation but is not a reference`)
            .toBe("reference");
        }
      }
    }
  });

  it("points every relation at a registered entity", () => {
    for (const entity of DATA_ENTITIES) {
      for (const field of entity.fields) {
        if (!field.relation) continue;
        expect(
          findEntity(field.relation.entity),
          `${entity.key}.${field.key} → unknown ${field.relation.entity}`,
        ).toBeTruthy();
        expect(field.relation.lookupFields.length).toBeGreaterThan(0);
      }
    }
  });

  it("compiles every validation pattern", () => {
    // A malformed pattern would be silently ignored at runtime (by design, so
    // a bad definition never fails a user's row) — which means only a test can
    // catch it.
    for (const entity of DATA_ENTITIES) {
      for (const field of entity.fields) {
        if (!field.validation?.pattern) continue;
        expect(
          () => new RegExp(field.validation!.pattern!),
          `${entity.key}.${field.key} has an invalid pattern`,
        ).not.toThrow();
      }
    }
  });

  it("never marks a read-only field required", () => {
    // It would be unsatisfiable: a required field the mapping cannot fill
    // fails every row of every file.
    for (const entity of DATA_ENTITIES) {
      for (const field of entity.fields) {
        expect(
          field.readOnly && field.required,
          `${entity.key}.${field.key} is required but read-only`,
        ).toBeFalsy();
      }
    }
  });
});

describe("permissions", () => {
  it("names a real permission for each direction", () => {
    for (const entity of DATA_ENTITIES) {
      expect(ALL_PERMISSIONS, `${entity.key} export`).toContain(entity.exportPermission);
      if (entity.importPermission) {
        expect(ALL_PERMISSIONS, `${entity.key} import`).toContain(entity.importPermission);
      }
    }
  });

  it("never lets a floor role reach another app's data through the engine", () => {
    // The engine keys (`data.import`/`data.export`) are intersected with the
    // entity's own key on every route, so this asserts the second half is
    // meaningful: a waiter holds neither the engine keys nor, for instance,
    // `crm.export`.
    for (const role of ["waiter", "kitchen"] as const) {
      const granted = new Set(roleBasePermissions(role));
      expect(granted.has("data.export")).toBe(false);
      expect(granted.has("data.import")).toBe(false);
    }
  });

  it("gives an entity with no import permission no importable fields to offer", () => {
    for (const entity of DATA_ENTITIES) {
      if (entity.importPermission) continue;
      // Export-only entities are all-read-only by construction; `isImportable`
      // is what the UI asks, and it must agree.
      expect(isImportable(entity), `${entity.key}`).toBe(false);
    }
  });

  it("gives every importable entity at least one writable required-or-not field", () => {
    for (const entity of DATA_ENTITIES) {
      if (!entity.importPermission) continue;
      expect(importableFields(entity).length, `${entity.key}`).toBeGreaterThan(0);
    }
  });
});

describe("duplicate rules", () => {
  it("reference fields that exist on the entity", () => {
    for (const entity of DATA_ENTITIES) {
      for (const rule of entity.duplicateRules ?? []) {
        expect(rule.fields.length, `${entity.key}/${rule.key} has no fields`).toBeGreaterThan(0);
        for (const key of rule.fields) {
          expect(findField(entity, key), `${entity.key}/${rule.key} → unknown field ${key}`)
            .toBeTruthy();
        }
      }
    }
  });

  it("are uniquely keyed within an entity", () => {
    for (const entity of DATA_ENTITIES) {
      const keys = (entity.duplicateRules ?? []).map((rule) => rule.key);
      expect(new Set(keys).size, `${entity.key}`).toBe(keys.length);
    }
  });
});

describe("export defaults", () => {
  it("always produce at least one column", () => {
    // An export with no columns is an empty file the operator cannot diagnose.
    for (const entity of DATA_ENTITIES) {
      expect(defaultExportFields(entity).length, `${entity.key}`).toBeGreaterThan(0);
    }
  });

  it("only name fields the entity has", () => {
    for (const entity of DATA_ENTITIES) {
      for (const key of defaultExportFields(entity)) {
        expect(findField(entity, key), `${entity.key} → ${key}`).toBeTruthy();
      }
    }
  });

  it("leave the internal id out of the default selection", () => {
    // A uuid column is noise in a file a human reads, and re-importing it does
    // nothing — the engine matches on the duplicate rules, not on our id.
    for (const entity of DATA_ENTITIES) {
      expect(defaultExportFields(entity)).not.toContain("id");
    }
  });
});

describe("the industry filter (issue #799 §7)", () => {
  it("hides an entity from a trade it does not belong to", () => {
    // The BOQ import is the first entity that belongs to one industry only.
    // A restaurant opening «ورود و خروج داده» must not find it, and neither
    // may a tenant whose industry is unknown.
    const construction = entitiesForIndustry("architecture_construction");
    const cafe = entitiesForIndustry("food_service");
    expect(construction.map((entity) => entity.key)).toContain("workspace.boq_items");
    expect(cafe.map((entity) => entity.key)).not.toContain("workspace.boq_items");
    expect(entitiesForIndustry(null).map((entity) => entity.key)).not.toContain("workspace.boq_items");
    // Everything else is for everybody: the filter is a trade gate, not a
    // rewrite of the catalogue.
    expect(cafe.map((entity) => entity.key)).toEqual(
      DATA_ENTITIES.filter((entity) => entity.requiresIndustry !== "architecture_construction").map(
        (entity) => entity.key,
      ),
    );
  });

  it("keeps the database's own two columns out of an import", () => {
    // The unit price and the line total are computed by the BOQ trigger. An
    // importer that accepted them would be offering to store a number the row
    // is about to overwrite — so they are exported (a round trip is checkable)
    // and never importable.
    const entity = requireEntity("workspace.boq_items");
    const keys = importableFields(entity).map((field) => field.key);
    expect(keys).not.toContain("unitPriceRial");
    expect(keys).not.toContain("totalRial");
    expect(defaultExportFields(entity)).toEqual(
      expect.arrayContaining(["unitPriceRial", "totalRial"]),
    );
  });

  it("keeps the flag meaningful — module is not trade", () => {
    for (const entity of DATA_ENTITIES) {
      // An entity that declares a trade must have no import/export permission
      // outside it, or a business would be offered an action it cannot finish.
      if (!entity.requiresIndustry) continue;
      expect(entity.requiresIndustry, entity.key).toBe("architecture_construction");
    }
  });
});

describe("lookup helpers", () => {
  it("findEntity answers null for an unknown key rather than throwing", () => {
    // The key comes from a URL.
    expect(findEntity("nope.nope")).toBeNull();
    expect(findEntity(null)).toBeNull();
    expect(findEntity(undefined)).toBeNull();
  });

  it("requireEntity throws for an unknown key", () => {
    expect(() => requireEntity("nope.nope")).toThrow();
  });
});
