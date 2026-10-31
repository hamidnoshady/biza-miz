-- Issue #902 §5 — a template's variable mapping belongs to the template.
--
-- The renderer (`template-variables.ts`) fills a body's `%token` slots from
-- domain values, and position is the mapping: `variables[0]` → `%token`,
-- `[1]` → `%token2`, `[2]` → `%token3`. That mapping has to be stored with the
-- row, because it is what makes a send safe: without it a caller would have to
-- guess which value belongs in which sentence, which is exactly the "arbitrary
-- backend syntax" §5 rules out.
--
-- A library copy (0264) carries the library's declared variables. A template a
-- tenant wrote by hand before this column existed has none, and nothing can
-- infer a mapping from a body — so those rows keep `{}` and the managed send
-- path refuses them with `template_variables_undeclared`, which is an explicit
-- answer rather than a wrong message. Sending never guesses.

ALTER TABLE kavenegar_lookup_templates
    ADD COLUMN variables text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN kavenegar_lookup_templates.variables IS
    'Issue #902 §5: ordered domain variables — position 0 fills %token, 1 fills %token2, 2 fills %token3. Empty means the mapping is unknown and the managed send path refuses the template.';
