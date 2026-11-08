-- Catalogue model specifications. Existing watch RLS applies to these columns.
ALTER TABLE watch_item_attributes
  ADD COLUMN case_dimensions_mm numeric[],
  ADD COLUMN bracelet_color text,
  ADD COLUMN clasp_type text,
  ADD COLUMN case_color text,
  ADD COLUMN case_shape text;
