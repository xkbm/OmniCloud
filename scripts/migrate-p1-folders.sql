-- P1-full: conversión de carpetas espejo (file_metadata) a registro único
-- (virtual_folders + materializations).
-- Validado en rehearsal sobre branch Neon p1-staging el 2026-08-22.
-- Ejecutar statement por statement dentro de UNA transaccion.
-- Rollback: transaccional (ROLLBACK) o restaurar branch snapshot previo.

-- [A] Columna aditiva requerida (idempotente; ya aplicada en prod el 2026-08-22)
ALTER TABLE virtual_folders ADD COLUMN IF NOT EXISTS is_starred BOOLEAN NOT NULL DEFAULT FALSE;

-- [B1] Crear vf para toda carpeta fm sin equivalente (dedupe user+parent+name;
--      preserva starring del espejo)
INSERT INTO virtual_folders (id, user_id, name, parent_path, path, is_starred)
SELECT gen_random_uuid(), fm.user_id, fm.file_name, fm.virtual_path,
       fm.virtual_path || fm.file_name || '/', fm.is_starred
FROM file_metadata fm
WHERE fm.is_folder = TRUE AND NOT EXISTS (
  SELECT 1 FROM virtual_folders vf
  WHERE vf.user_id=fm.user_id AND vf.parent_path=fm.virtual_path AND vf.name=fm.file_name);

-- [B2] Materializacion por cada par (vf,fm) sin una activa en esa cuenta
INSERT INTO virtual_folder_materializations (id, user_id, virtual_folder_id,
  cloud_account_id, remote_file_id, remote_parent_id, status)
SELECT gen_random_uuid(), fm.user_id, vf.id, fm.cloud_account_id, fm.remote_file_id,
       fm.remote_parent_id, 'active'
FROM file_metadata fm
JOIN virtual_folders vf ON vf.user_id=fm.user_id AND vf.parent_path=fm.virtual_path AND vf.name=fm.file_name
WHERE fm.is_folder = TRUE AND NOT EXISTS (
  SELECT 1 FROM virtual_folder_materializations x
  WHERE x.virtual_folder_id=vf.id AND x.user_id=fm.user_id AND x.cloud_account_id=fm.cloud_account_id);

-- [B3] Union de starring: vf queda starred SOLO si su espejo lo estaba
--      (FIX de rehearsal v1: faltaba el predicado fm.is_starred=TRUE)
UPDATE virtual_folders vf SET is_starred = TRUE
WHERE vf.is_starred = FALSE AND EXISTS (
  SELECT 1 FROM file_metadata fm WHERE fm.is_folder=TRUE AND fm.user_id=vf.user_id
    AND fm.virtual_path=vf.parent_path AND fm.file_name=vf.name AND fm.is_starred = TRUE);

-- [B4] Purgar espejos (file_metadata queda solo con archivos)
DELETE FROM file_metadata WHERE is_folder = TRUE;
