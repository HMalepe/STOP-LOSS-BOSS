-- Phase 08 presets (OD3). One name per owner (case-insensitive), recipes are always JSON objects.
alter table presets add constraint presets_recipe_is_object check (jsonb_typeof(recipe) = 'object');
create unique index presets_user_name on presets (user_id, lower(name));
create index presets_user_order on presets (user_id, pinned desc, sort, lower(name));
