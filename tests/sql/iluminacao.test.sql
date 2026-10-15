-- 026: devices.lighting aceita objeto e recusa outros tipos; a fila de comandos continua igual
do $$
declare v_id uuid;
begin
  insert into public.devices (name, type, room, status, lighting)
  values ('Luz teste 026', 'light', 'Cozinha', '{"on": false}',
          '{"fixtures": [{"model": "spot", "x": 1, "z": 2, "floor": 0}], "switches": [], "control": {"mode": "parede"}}')
  returning id into v_id;
  if (select lighting->'fixtures'->0->>'model' from public.devices where id = v_id) <> 'spot' then
    raise exception 'lighting não gravou';
  end if;
  begin
    update public.devices set lighting = '[1,2]' where id = v_id;
    raise exception 'lighting aceitou um array';
  exception when check_violation then null;
  end;
  delete from public.devices where id = v_id;
  raise notice 'OK 026 iluminação';
end $$;
