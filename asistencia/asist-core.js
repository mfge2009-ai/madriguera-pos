// ═══════════════════════════════════════════════════════════════
//  ASISTENCIA — lógica compartida (sin Firebase, sin pantalla)
//  La usan: asistencia/index.html (celular), asistencia/reloj.html
//  (pantalla del QR) y el POS (módulo Asistencia, solo admin).
//
//  marca: {id, uid, tipo, ts(ms), origen:'qr'|'admin', motivo?, regreso?(ms),
//          anula?(id), dist?, prec?, disp?}
//  tipo:  entrada | pausa | permiso | regreso | salida | anula
//
//  Reglas de cálculo (configurables en lm_asist_cfg/local):
//   - Se paga solo el tiempo entre una entrada/regreso y la siguiente
//     pausa/permiso/salida. Pausas y permisos NO se pagan.
//   - Un tramo sin cierre (olvidó marcar la salida) NO se paga hasta que
//     administración registre la salida con su motivo.
//   - Por día (el del inicio del tramo): hasta 8 h ordinarias; lo que
//     pasa de 8 h es suplementario (50 %; 100 % entre 00:00 y 06:00).
//   - Día de descanso del trabajador (fuera de su horario) o feriado:
//     todas las horas son extraordinarias (100 %).
//   - Recargo nocturno 25 % sobre horas ordinarias entre 19:00 y 06:00.
// ═══════════════════════════════════════════════════════════════

export const TIPOS = ['entrada','pausa','permiso','regreso','salida'];
export const TIPO_TXT = {entrada:'Entrada', pausa:'Inicio de pausa', permiso:'Salida con permiso',
  regreso:'Regreso', salida:'Salida', anula:'Anulación'};
export const CFG_DEF = {radio:80, precMax:150, tolEntrada:5, tolRetorno:15, pausaMax:60,
  nocturno:true, descansoExtra:true, feriados:[]};

const MIN = 60000;
export const r2 = n => Math.round((+n || 0) * 100) / 100;
export const pad = n => String(n).padStart(2, '0');
export const diaDe = ms => { const d = new Date(ms); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
export const horaDe = ms => { const d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
export const inicioDia = dia => { const [y, m, d] = dia.split('-').map(Number); return new Date(y, m - 1, d, 0, 0, 0, 0).getTime(); };
export const diaSiguiente = dia => { const [y, m, d] = dia.split('-').map(Number); return diaDe(new Date(y, m - 1, d + 1, 12).getTime()); };
export const msDeHora = (dia, hhmm) => { const [h, m] = String(hhmm || '0:0').split(':').map(Number); return inicioDia(dia) + (h * 60 + (m || 0)) * MIN; };
export const fmtMin = m => { m = Math.round(m || 0); const s = m < 0 ? '-' : ''; m = Math.abs(m); return s + Math.floor(m / 60) + 'h' + pad(m % 60); };

// ── Geocerca ──────────────────────────────────────────────────
export function distanciaM(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = x => x * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
// Cuadro que verifican las reglas de Firestore (no saben calcular distancias).
export function cajaGeocerca(lat, radio) {
  const dLat = radio / 111320;
  const dLng = radio / (111320 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
  return {dLat: +dLat.toFixed(7), dLng: +dLng.toFixed(7)};
}
export function dentroGeocerca(cfg, lat, lng, prec) {
  if (!cfg || typeof cfg.lat !== 'number') return {ok: false, motivo: 'La ubicación del local no está configurada.'};
  const dist = Math.round(distanciaM(cfg.lat, cfg.lng, lat, lng));
  if (prec > (cfg.precMax || CFG_DEF.precMax)) return {ok: false, dist, motivo: 'La señal de ubicación es imprecisa (±' + Math.round(prec) + ' m). Acércate a la puerta o activa el Wi-Fi.'};
  const enCaja = Math.abs(lat - cfg.lat) <= cfg.dLat && Math.abs(lng - cfg.lng) <= cfg.dLng;
  if (!enCaja || dist > (cfg.radio || CFG_DEF.radio) * 1.42) return {ok: false, dist, motivo: 'Estás a ' + dist + ' m de La Madriguera. Solo se puede marcar en el local.'};
  return {ok: true, dist};
}

// ── Marcas válidas (descarta las anuladas por administración) ──
export function marcasValidas(marcas) {
  const anuladas = new Set(marcas.filter(m => m.tipo === 'anula' && m.anula).map(m => m.anula));
  return marcas.filter(m => m.tipo !== 'anula' && !anuladas.has(m.id) && TIPOS.includes(m.tipo))
    .sort((a, b) => a.ts - b.ts || (a.id || '').localeCompare(b.id || ''));
}

// ── Recorrido de las marcas de UNA persona ───────────────────
// Devuelve tramos pagables, estado al final y anomalías.
export function recorrer(marcas, ahora = Date.now()) {
  const ms = marcasValidas(marcas);
  const tramos = [], anomalias = [];
  let estado = 'fuera', abierto = null, desde = null, regreso = null, motivo = '';
  for (const m of ms) {
    // Un turno abierto hace más de 16 h (o una entrada de otro día con el turno anterior abierto) no se une al siguiente:
    // queda como «sin salida» y no se paga hasta que administración la registre.
    if (estado === 'dentro' && abierto != null && (m.ts - abierto > 16 * 60 * MIN || (m.tipo === 'entrada' && diaDe(abierto) !== diaDe(m.ts)))) {
      anomalias.push({ts: abierto, sinSalida: true, txt: 'Sin marca de salida desde ' + diaDe(abierto) + ' ' + horaDe(abierto) + ' (no se paga hasta registrar la salida)'});
      estado = 'fuera'; abierto = null;
      if (m.tipo !== 'entrada' && m.tipo !== 'regreso') { anomalias.push({ts: m.ts, txt: TIPO_TXT[m.tipo] + ' sin entrada previa el ' + diaDe(m.ts) + ' a las ' + horaDe(m.ts)}); desde = m.ts; continue; }
    }
    if (m.tipo === 'entrada') {
      if (estado === 'dentro') { anomalias.push({ts: m.ts, txt: 'Entrada repetida a las ' + horaDe(m.ts) + ' (ya estaba dentro desde ' + horaDe(abierto) + ')'}); continue; }
      if ((estado === 'pausa' || estado === 'permiso') && desde != null && diaDe(desde) === diaDe(m.ts)) anomalias.push({ts: m.ts, txt: 'Marcó entrada en lugar de regreso a las ' + horaDe(m.ts)});
      abierto = m.ts; estado = 'dentro'; desde = m.ts; regreso = null; motivo = '';
    } else if (m.tipo === 'regreso') {
      if (estado === 'dentro') { anomalias.push({ts: m.ts, txt: 'Regreso sin pausa ni permiso a las ' + horaDe(m.ts)}); continue; }
      if (estado === 'fuera') anomalias.push({ts: m.ts, txt: 'Regreso sin entrada previa a las ' + horaDe(m.ts) + ' (se toma como entrada)'});
      abierto = m.ts; estado = 'dentro'; desde = m.ts; regreso = null; motivo = '';
    } else { // pausa | permiso | salida
      if (estado === 'dentro') { tramos.push({ini: abierto, fin: m.ts}); abierto = null; }
      else if (m.tipo !== 'salida' || estado === 'fuera') anomalias.push({ts: m.ts, txt: TIPO_TXT[m.tipo] + ' sin estar dentro a las ' + horaDe(m.ts)});
      estado = m.tipo === 'salida' ? 'fuera' : m.tipo; desde = m.ts;
      regreso = m.tipo === 'permiso' ? (m.regreso || null) : null;
      motivo = m.tipo === 'permiso' ? (m.motivo || '') : '';
    }
  }
  let enCurso = null;
  if (estado === 'dentro' && abierto != null) {
    if (diaDe(abierto) === diaDe(ahora) && ahora - abierto < 16 * 60 * MIN) enCurso = {ini: abierto, fin: ahora};
    else anomalias.push({ts: abierto, sinSalida: true, txt: 'Sin marca de salida desde ' + diaDe(abierto) + ' ' + horaDe(abierto) + ' (no se paga hasta registrar la salida)'});
  }
  return {tramos, estado, desde, regreso, motivo, enCurso, anomalias, marcas: ms};
}

// ── Clasificación de minutos de un conjunto de tramos ─────────
// horario: {'0':{ini,fin}, ... '6':{...}} (0 = domingo). Vacío = sin horario.
function esDiaExtra(dia, horario, cfg) {
  if ((cfg.feriados || []).includes(dia)) return true;
  if (cfg.descansoExtra === false) return false;
  if (!horario || !Object.keys(horario).length) return false;
  const dow = String(new Date(inicioDia(dia)).getDay());
  return !horario[dow];
}
export function clasificar(tramos, horario, cfg = CFG_DEF) {
  cfg = Object.assign({}, CFG_DEF, cfg || {});
  const porDia = {};
  for (const t of tramos) { const d = diaDe(t.ini); (porDia[d] = porDia[d] || []).push(t); }
  const res = {};
  for (const dia of Object.keys(porDia).sort()) {
    const extra = esDiaExtra(dia, horario, cfg);
    const c = {dia, extra, total: 0, ord: 0, noc: 0, sup50: 0, sup100: 0, ext: 0};
    let acum = 0;
    for (const t of porDia[dia].sort((a, b) => a.ini - b.ini)) {
      for (let x = t.ini; x < t.fin; x += MIN) {
        const w = Math.min(1, (t.fin - x) / MIN);
        const h = new Date(x).getHours();
        const noct = h >= 19 || h < 6, madrugada = h < 6;
        if (extra) c.ext += w;
        else if (acum < 480) { c.ord += w; if (noct && cfg.nocturno !== false) c.noc += w; }
        else if (madrugada) c.sup100 += w;
        else c.sup50 += w;
        acum += w; c.total += w;
      }
    }
    for (const k of ['total','ord','noc','sup50','sup100','ext']) c[k] = Math.round(c[k] * 100) / 100;
    res[dia] = c;
  }
  return res;
}
export function montoDe(c, tarifa) {
  const t = (+tarifa || 0) / 60;
  return r2(t * (c.ord + c.noc * 0.25 + c.sup50 * 1.5 + c.sup100 * 2 + c.ext * 2));
}
export function sumar(dias) {
  const s = {total: 0, ord: 0, noc: 0, sup50: 0, sup100: 0, ext: 0};
  for (const c of Object.values(dias)) for (const k in s) s[k] += c[k] || 0;
  for (const k in s) s[k] = Math.round(s[k] * 100) / 100;
  return s;
}

// ── Puntualidad: atrasos, salidas anticipadas y faltas ────────
export function puntualidad(marcas, horario, desdeDia, hastaDia, cfg = CFG_DEF, ahora = Date.now()) {
  cfg = Object.assign({}, CFG_DEF, cfg || {});
  const ms = marcasValidas(marcas), out = [];
  if (!horario || !Object.keys(horario).length) return out;
  for (let dia = desdeDia; dia <= hastaDia; dia = diaSiguiente(dia)) {
    const t = inicioDia(dia), h = horario[String(new Date(t).getDay())];
    if (!h || (cfg.feriados || []).includes(dia)) continue;
    const ini = msDeHora(dia, h.ini), fin = msDeHora(dia, h.fin);
    const delDia = ms.filter(m => diaDe(m.ts) === dia);
    const ent = delDia.find(m => m.tipo === 'entrada');
    if (!ent) {
      if (ahora > ini + cfg.tolEntrada * MIN) out.push({dia, tipo: dia === diaDe(ahora) ? 'sin_entrada' : 'falta', min: 0,
        txt: dia === diaDe(ahora) ? 'No ha marcado entrada (horario ' + h.ini + ')' : 'Falta: sin marcas (horario ' + h.ini + '–' + h.fin + ')'});
      continue;
    }
    const atraso = Math.round((ent.ts - ini) / MIN);
    if (atraso > cfg.tolEntrada) out.push({dia, tipo: 'atraso', min: atraso, txt: 'Atraso de ' + atraso + ' min (entró ' + horaDe(ent.ts) + ', horario ' + h.ini + ')'});
    const sal = [...delDia].reverse().find(m => m.tipo === 'salida');
    if (sal && sal.ts < fin - cfg.tolEntrada * MIN) {
      const ant = Math.round((fin - sal.ts) / MIN);
      out.push({dia, tipo: 'salida_anticipada', min: ant, txt: 'Salió ' + ant + ' min antes (' + horaDe(sal.ts) + ', horario hasta ' + h.fin + ')'});
    }
  }
  return out;
}

// ── Alertas del momento (tablero de hoy, Inicio del POS, reloj) ─
export function alertasAhora(persona, marcasHoy, cfg = CFG_DEF, ahora = Date.now()) {
  cfg = Object.assign({}, CFG_DEF, cfg || {});
  const r = recorrer(marcasHoy, ahora), out = [];
  const nombre = persona.nombre || 'Trabajador';
  if (r.estado === 'permiso' && r.regreso && ahora > r.regreso + cfg.tolRetorno * MIN) {
    const min = Math.round((ahora - r.regreso) / MIN);
    out.push({sev: 'alta', tipo: 'no_regreso', txt: nombre + ' no ha regresado del permiso', desc: 'Salió ' + horaDe(r.desde) + (r.motivo ? ' («' + r.motivo + '»)' : '') + '; regreso previsto ' + horaDe(r.regreso) + ' · ' + fmtMin(min) + ' de retraso. Ese tiempo no se paga.'});
  }
  if (r.estado === 'pausa' && ahora - r.desde > cfg.pausaMax * MIN)
    out.push({sev: 'media', tipo: 'pausa_larga', txt: nombre + ' lleva ' + fmtMin((ahora - r.desde) / MIN) + ' en pausa', desc: 'Desde ' + horaDe(r.desde) + '. La pausa no se paga.'});
  const h = persona.horario && persona.horario[String(new Date(ahora).getDay())];
  const hoy = diaDe(ahora);
  if (h && !(cfg.feriados || []).includes(hoy)) {
    if (!r.marcas.length && ahora > msDeHora(hoy, h.ini) + cfg.tolEntrada * MIN && ahora < msDeHora(hoy, h.fin))
      out.push({sev: 'media', tipo: 'sin_entrada', txt: nombre + ' no ha marcado entrada', desc: 'Su horario empezó a las ' + h.ini + '.'});
    if (r.estado === 'dentro' && ahora > msDeHora(hoy, h.fin) + 60 * MIN)
      out.push({sev: 'baja', tipo: 'sin_salida', txt: nombre + ' sigue dentro después de su horario', desc: 'Horario hasta ' + h.fin + '. ¿Olvidó marcar la salida?'});
  }
  return out;
}

// ── Mismo celular usado por varias personas (posible marcación por otro) ─
export function dispositivosCompartidos(marcas) {
  const por = {};
  for (const m of marcas) if (m.disp && m.origen === 'qr') (por[m.disp] = por[m.disp] || new Set()).add(m.uid);
  return Object.entries(por).filter(([, s]) => s.size > 1).map(([disp, s]) => ({disp, uids: [...s]}));
}

// Botones que corresponden al estado actual
export function accionesPara(estado) {
  if (estado === 'dentro') return ['pausa','permiso','salida'];
  if (estado === 'pausa' || estado === 'permiso') return ['regreso','salida'];
  return ['entrada'];
}

// Token aleatorio para el QR (base64url, 16 bytes)
export function nuevoToken() {
  const b = new Uint8Array(16); crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
