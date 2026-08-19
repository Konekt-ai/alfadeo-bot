-- =====================================================================
-- Rol de PostgreSQL para el bot de WhatsApp
-- =====================================================================
-- Se corre UNA vez, en la computadora del mostrador, como superusuario:
--
--     psql -U postgres -p 5433 -d alfadeo -f sql/rol-bot.sql
--
-- Antes de correrlo, cambia la contraseña de la línea de abajo y ponla
-- igual en DATABASE_URL del .env del bot.
--
-- POR QUÉ ESTE ARCHIVO EXISTE
-- El bot es la única pieza del sistema que recibe tráfico de internet (los
-- webhooks de Meta). Es justo a la que menos conviene darle las llaves de
-- toda la base. El rol `alfadeo` que usa el panel puede tocarlo todo:
-- ventas, inventario, traslados, precios. El bot no necesita nada de eso.
--
-- Con este rol, alguien que comprometiera el proceso del bot alcanza seis
-- tablas y una función de búsqueda. No puede borrar nada, no puede ver
-- ventas ni movimientos de inventario, y no puede cambiar precios.
-- =====================================================================

-- --------------------------------------------------------------- rol ---
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'bot') then
    create role bot login password 'CAMBIA_ESTA_CONTRASENA';
  end if;
end
$$;

-- Puede conectarse a la base y ver el esquema, nada más.
grant connect on database alfadeo to bot;
grant usage   on schema public   to bot;

-- ------------------------------------------------------------ lectura ---
-- Sólo lo que el bot lee para atender una conversación.
grant select on sucursales to bot;

-- productos e inventario hacen falta AUNQUE el bot nunca los consulte directo.
-- La razón: buscar_productos() está declarada `language sql stable`, SIN
-- `security definer`, así que corre con los permisos de quien la llama. Por
-- dentro hace `from productos` y `join inventario`. Sin estos dos grants, la
-- búsqueda truena con "permission denied for table productos" y el bot le
-- contesta al cliente que no encontró el producto.
--
-- Si algún día la función se marca `security definer`, estos dos grants se
-- pueden quitar.
grant select on productos  to bot;
grant select on inventario to bot;

-- ------------------------------------------------- lectura y escritura ---
-- El estado de la conversación, el cliente y la solicitud que genera.
-- Ojo: NO se otorga DELETE. El bot nunca borra; si algo hay que borrar, se
-- hace desde el panel o a mano.
grant select, insert, update on clientes         to bot;
grant select, insert, update on conversaciones   to bot;
grant select, insert, update on solicitudes      to bot;
grant select, insert, update on solicitud_items  to bot;
grant select, insert         on mensajes         to bot;

-- NO se otorgan las secuencias. El folio de `solicitudes` es
-- GENERATED ALWAYS AS IDENTITY, y en ese caso Postgres avanza la secuencia por
-- dentro sin pedirle permiso al rol que inserta. Un `grant on all sequences`
-- le habría entregado de paso todas las secuencias del panel.
--
-- Si alguna tabla usara `serial` en vez de identidad, ahí sí haría falta el
-- grant, pero sólo sobre esa secuencia por su nombre.

-- ----------------------------------------------------------- funciones ---
-- La búsqueda de catálogo. Es la MISMA función que usa el panel: ahí vive el
-- ranking, para que los dos ordenen igual.
grant execute on function buscar_productos(text, int) to bot;

-- =====================================================================
-- Lo que deliberadamente NO se otorga:
--   · ventas, movimientos, traslados   -> son del panel
--   · precios de compra y proveedores  -> son del panel
--   · DELETE sobre cualquier tabla
--   · CREATE / ALTER / DROP
-- =====================================================================

-- Para comprobar qué quedó:
--     \dp
--     select * from information_schema.role_table_grants where grantee = 'bot';
