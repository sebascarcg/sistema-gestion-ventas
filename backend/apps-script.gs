/**
 * Sistema de Gestión de Ventas y Membresías — Backend (Google Apps Script)
 * =========================================================================
 * Este archivo se pega en el proyecto de Apps Script vinculado a la hoja
 * "SISTEMA DE GESTIÓN DE VENTAS Y MEMBRESÍAS" y se despliega como Web App:
 *   - Ejecutar como: Yo (Me)
 *   - Quién tiene acceso: Cualquier persona (Anyone)
 *
 * La seguridad NO depende de ocultar la URL: cada acción (salvo pedir el
 * código) exige un token de sesión válido, y los códigos solo se envían a
 * los correos autorizados en la pestaña ACCESOS.
 *
 * La hoja de cálculo es la base de verdad. Este backend es el ÚNICO que
 * escribe en ella desde la web. NUNCA escribe en POR VENCER ni en VENCIDAS
 * (son pestañas de fórmulas).
 */

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

var SPREADSHEET_ID = '1f8BsEg4sPPTRXgVSryOzQUA0QQqc1knkva5WudAuC48';
var TIMEZONE = 'America/Bogota';

var OWNER_EMAIL = 'sebastiancgcg@gmail.com';

// Correos con los que se siembra ACCESOS la primera vez (si está vacía).
var BOOTSTRAP_ACCESOS = [
  { email: 'sebastiancgcg@gmail.com',  nombre: 'Sebastian (dueño)' },
  { email: 'sebastiancgcg2@gmail.com', nombre: 'Sebastian' },
  { email: 'pedidon581@gmail.com',    nombre: 'Natalia' },
  { email: 'correosc081@gmail.com',   nombre: 'Agente (hermano)' }
];

var OTP_TTL_MIN = 10;        // minutos de validez del código
var OTP_MAX_ATTEMPTS = 5;    // intentos máximos por código
var SESSION_TTL_HOURS = 12;  // horas de validez del token de sesión

var SHEETS = {
  REGISTROS: 'REGISTROS',
  HISTORIAL: 'HISTORIAL',
  ACCESOS:   'ACCESOS',
  BITACORA:  'BITACORA',
  SESIONES:  'SESIONES' // oculta: guarda hashes de tokens, nunca el token
};

var HEADERS = {
  REGISTROS: ['Código', 'Fecha de Inicio', 'Cliente', 'Correo Electrónico',
    'Fecha de Vencimiento', 'Servicio', 'Duración', 'Precio', 'Estado',
    'Correo de Membresía', 'Teléfono / Contacto', 'Renovaciones'],
  HISTORIAL: ['Código', 'Cliente', 'Tipo', 'Fecha de activación',
    'Inicio del periodo', 'Duración', 'Precio', 'Nuevo vencimiento'],
  ACCESOS:   ['Correo', 'Nombre', 'Agregado por', 'Fecha'],
  BITACORA:  ['Fecha y hora', 'Correo usuario', 'Acción', 'Detalle'],
  SESIONES:  ['TokenHash', 'Correo', 'Expira']
};

// ---------------------------------------------------------------------------
// Entrada HTTP
// ---------------------------------------------------------------------------

function doGet() {
  return jsonOut_({ ok: true, service: 'Sistema de Gestión de Ventas', status: 'activo' });
}

function doPost(e) {
  try {
    var body = {};
    if (e && e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    }
    var action = String(body.action || '');
    var result;

    // Acciones públicas (login)
    if (action === 'requestCode') { result = requestCode_(body); return jsonOut_(result); }
    if (action === 'verifyCode')  { result = verifyCode_(body);  return jsonOut_(result); }

    // Todo lo demás exige sesión válida. El actor sale de la sesión,
    // NUNCA de un dato enviado por el cliente.
    var actor = requireAuth_(body.token);
    if (!actor) {
      return jsonOut_({ ok: false, error: 'Sesión no válida o vencida. Vuelve a ingresar.' });
    }

    switch (action) {
      case 'getState':     result = getState_();                    break;
      case 'createSale':   result = createSale_(body, actor);       break;
      case 'renew':        result = renew_(body, actor);            break;
      case 'cancel':       result = cancel_(body, actor);            break;
      case 'addAccess':    result = addAccess_(body, actor);        break;
      case 'removeAccess': result = removeAccess_(body, actor);     break;
      case 'logout':
        revokeSession_(body.token);
        result = { ok: true };
        break;
      default:
        result = { ok: false, error: 'Acción no reconocida: ' + action };
    }
    return jsonOut_(result);
  } catch (err) {
    return jsonOut_({ ok: false, error: 'Error del servidor: ' + err.message });
  }
}

function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------------
// Utilidades generales
// ---------------------------------------------------------------------------

function ss_() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function sheet_(name) {
  var ss = ss_();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    var headers = HEADERS[name];
    if (headers) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    }
  }
  return sh;
}

/** Crea las pestañas nuevas que el sistema necesita y siembra ACCESOS. */
function bootstrap_() {
  sheet_(SHEETS.HISTORIAL);
  sheet_(SHEETS.BITACORA);
  var sesiones = sheet_(SHEETS.SESIONES);
  try { sesiones.hideSheet(); } catch (e) { /* ya estaba oculta */ }

  var accesos = sheet_(SHEETS.ACCESOS);
  var values = accesos.getDataRange().getValues();
  var tieneDatos = false;
  for (var i = 1; i < values.length; i++) {
    if (values[i][0]) { tieneDatos = true; break; }
  }
  if (!tieneDatos) {
    var rows = BOOTSTRAP_ACCESOS.map(function (a) {
      return [a.email, a.nombre, 'sistema', nowStr_()];
    });
    accesos.getRange(2, 1, rows.length, 4).setValues(rows);
  }
}

/** Ejecuta esta función una vez desde el editor para preparar la hoja. */
function setupInicial() {
  bootstrap_();
}

function nowStr_() {
  return Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
}

function todayStr_() {
  return Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd');
}

/** Normaliza cualquier fecha (Date, texto o número) a 'yyyy-MM-dd'. */
function dateStr_(value) {
  if (value === null || value === undefined || value === '') return '';
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) {
    return Utilities.formatDate(value, TIMEZONE, 'yyyy-MM-dd');
  }
  var s = String(value).trim();
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  var d = new Date(s);
  if (!isNaN(d)) return Utilities.formatDate(d, TIMEZONE, 'yyyy-MM-dd');
  return s;
}

/** Convierte 'yyyy-MM-dd' a Date a medianoche en la zona del negocio. */
function parseDay_(yyyyMmDd) {
  var p = String(yyyyMmDd).split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}

/**
 * Suma meses con lógica tipo EDATE de Sheets: si el día no existe en el
 * mes destino (ej. 31 de enero + 1 mes), cae al último día de ese mes.
 */
function addMonths_(yyyyMmDd, months) {
  var d = parseDay_(yyyyMmDd);
  var day = d.getDate();
  var target = new Date(d.getFullYear(), d.getMonth() + months, 1);
  var lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, lastDay));
  return Utilities.formatDate(target, TIMEZONE, 'yyyy-MM-dd');
}

function duracionLabel_(meses) {
  meses = Number(meses);
  return meses === 1 ? '1 mes' : meses + ' meses';
}

function toNumber_(value) {
  if (typeof value === 'number') return value;
  var n = Number(String(value || '').replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

function normalizeEmail_(email) {
  return String(email || '').trim().toLowerCase();
}

function hash_(text) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, String(text), Utilities.Charset.UTF_8);
  return bytes.map(function (b) {
    var v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

// ---------------------------------------------------------------------------
// Accesos y bitácora
// ---------------------------------------------------------------------------

function readAccesos_() {
  bootstrap_();
  var values = sheet_(SHEETS.ACCESOS).getDataRange().getValues();
  var list = [];
  for (var i = 1; i < values.length; i++) {
    if (!values[i][0]) continue;
    list.push({
      email: normalizeEmail_(values[i][0]),
      nombre: String(values[i][1] || ''),
      agregadoPor: String(values[i][2] || ''),
      fecha: dateStr_(values[i][3]) || String(values[i][3] || '')
    });
  }
  return list;
}

function isAuthorized_(email) {
  return readAccesos_().some(function (a) { return a.email === email; });
}

function log_(actorEmail, accion, detalle) {
  var sh = sheet_(SHEETS.BITACORA);
  sh.appendRow([nowStr_(), actorEmail, accion, detalle || '']);
}

// ---------------------------------------------------------------------------
// Login: código de un solo uso por correo
// ---------------------------------------------------------------------------

function requestCode_(body) {
  var email = normalizeEmail_(body.email);
  // Respuesta genérica si el correo no es válido o no está autorizado:
  // no se revela si el correo existe en la lista.
  var generico = { ok: false, error: 'No fue posible enviar el código. Verifica el correo e inténtalo de nuevo.' };
  if (!email || email.indexOf('@') < 0) return generico;
  if (!isAuthorized_(email)) return generico;

  var code = String(Math.floor(100000 + Math.random() * 900000));
  var props = PropertiesService.getScriptProperties();
  props.setProperty('OTP_' + hash_(email), JSON.stringify({
    hash: hash_(code + '|' + email),
    expires: Date.now() + OTP_TTL_MIN * 60 * 1000,
    attempts: 0
  }));

  MailApp.sendEmail({
    to: email,
    subject: 'Tu código de acceso - Sistema de Ventas',
    body: 'Hola,\n\nTu código de acceso al Sistema de Gestión de Ventas es: ' + code +
      '\n\nEl código vence en ' + OTP_TTL_MIN + ' minutos y solo se puede usar una vez.' +
      '\nSi no pediste este código, ignora este correo.\n'
  });
  return { ok: true, message: 'Si el correo está autorizado, el código va en camino.' };
}

function verifyCode_(body) {
  var email = normalizeEmail_(body.email);
  var code = String(body.code || '').trim();
  var props = PropertiesService.getScriptProperties();
  var key = 'OTP_' + hash_(email);
  var stored = props.getProperty(key);
  var invalido = { ok: false, error: 'Código no válido o vencido. Pide uno nuevo.' };
  if (!stored) return invalido;

  var data = JSON.parse(stored);
  if (Date.now() > data.expires) { props.deleteProperty(key); return invalido; }
  if (data.attempts >= OTP_MAX_ATTEMPTS) { props.deleteProperty(key); return invalido; }

  if (hash_(code + '|' + email) !== data.hash) {
    data.attempts++;
    props.setProperty(key, JSON.stringify(data));
    return invalido;
  }

  // Código correcto: se quema (un solo uso) y se crea la sesión.
  props.deleteProperty(key);
  var token = Utilities.getUuid().replace(/-/g, '') +
    Utilities.getUuid().replace(/-/g, '');
  var expira = new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000);
  withLock_(function () {
    sheet_(SHEETS.SESIONES).appendRow([hash_(token), email, expira.toISOString()]);
  });
  return { ok: true, token: token, email: email };
}

function requireAuth_(token) {
  if (!token) return null;
  var tokenHash = hash_(token);
  var values = sheet_(SHEETS.SESIONES).getDataRange().getValues();
  var now = Date.now();
  for (var i = 1; i < values.length; i++) {
    if (values[i][0] === tokenHash) {
      var expira = new Date(values[i][2]).getTime();
      if (!isNaN(expira) && now <= expira) return normalizeEmail_(values[i][1]);
      return null; // sesión vencida
    }
  }
  return null;
}

function revokeSession_(token) {
  if (!token) return;
  var tokenHash = hash_(token);
  var sh = sheet_(SHEETS.SESIONES);
  var values = sh.getDataRange().getValues();
  for (var i = values.length - 1; i >= 1; i--) {
    if (values[i][0] === tokenHash) sh.deleteRow(i + 1);
  }
}

// ---------------------------------------------------------------------------
// Lectura de estado
// ---------------------------------------------------------------------------

/**
 * Calcula el estado igual que la hoja: CANCELADA manda lo guardado;
 * si el vencimiento ya pasó → VENCIDA; si vence hoy o en los próximos
 * 3 días → POR VENCER; el resto → ACTIVA.
 */
function estadoCalculado_(estadoGuardado, vencimientoStr) {
  if (String(estadoGuardado || '').toUpperCase() === 'CANCELADA') return 'CANCELADA';
  if (!vencimientoStr) return String(estadoGuardado || 'ACTIVA').toUpperCase();
  var hoy = todayStr_();
  var enTresDias = addMonthsDays_(hoy, 3);
  if (vencimientoStr < hoy) return 'VENCIDA';
  if (vencimientoStr <= enTresDias) return 'POR VENCER';
  return 'ACTIVA';
}

function addMonthsDays_(yyyyMmDd, days) {
  var d = parseDay_(yyyyMmDd);
  d.setDate(d.getDate() + days);
  return Utilities.formatDate(d, TIMEZONE, 'yyyy-MM-dd');
}

function readClientes_() {
  var values = sheet_(SHEETS.REGISTROS).getDataRange().getValues();
  var clientes = [];
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    if (!r[0]) continue;
    var vencimiento = dateStr_(r[4]);
    clientes.push({
      codigo: String(r[0]),
      fechaInicio: dateStr_(r[1]),
      cliente: String(r[2] || ''),
      correo: String(r[3] || ''),
      fechaVencimiento: vencimiento,
      servicio: String(r[5] || 'gemini'),
      duracion: String(r[6] || ''),
      precio: toNumber_(r[7]),
      estado: estadoCalculado_(r[8], vencimiento),
      correoMembresia: String(r[9] || ''),
      telefono: String(r[10] || ''),
      renovaciones: Number(r[11]) || 0
    });
  }
  return clientes;
}

function readHistorial_() {
  var values = sheet_(SHEETS.HISTORIAL).getDataRange().getValues();
  var eventos = [];
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    if (!r[0]) continue;
    eventos.push({
      codigo: String(r[0]),
      cliente: String(r[1] || ''),
      tipo: String(r[2] || ''),
      fechaActivacion: dateStr_(r[3]),
      inicioPeriodo: dateStr_(r[4]),
      duracion: String(r[5] || ''),
      precio: toNumber_(r[6]),
      nuevoVencimiento: dateStr_(r[7])
    });
  }
  return eventos;
}

function readBitacora_(max) {
  var values = sheet_(SHEETS.BITACORA).getDataRange().getValues();
  var entradas = [];
  for (var i = values.length - 1; i >= 1 && entradas.length < max; i--) {
    var r = values[i];
    if (!r[0]) continue;
    entradas.push({
      fecha: Object.prototype.toString.call(r[0]) === '[object Date]'
        ? Utilities.formatDate(r[0], TIMEZONE, 'yyyy-MM-dd HH:mm:ss')
        : String(r[0]),
      correo: String(r[1] || ''),
      accion: String(r[2] || ''),
      detalle: String(r[3] || '')
    });
  }
  return entradas;
}

function getState_() {
  bootstrap_();
  return {
    ok: true,
    clientes: readClientes_(),
    historial: readHistorial_(),
    accesos: readAccesos_(),
    bitacora: readBitacora_(100)
  };
}

// ---------------------------------------------------------------------------
// Historial (escritura idempotente)
// ---------------------------------------------------------------------------

/**
 * Agrega un evento al HISTORIAL solo si no existe ya uno con la misma
 * clave Código + Tipo + Fecha de activación + Precio. Así, repetir una
 * sincronización u operación nunca duplica el historial.
 */
function appendHistorial_(evento) {
  var sh = sheet_(SHEETS.HISTORIAL);
  var clave = [evento.codigo, evento.tipo, evento.fechaActivacion, String(evento.precio)].join('|');
  var values = sh.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    if (!r[0]) continue;
    var existente = [String(r[0]), String(r[2]), dateStr_(r[3]), String(toNumber_(r[6]))].join('|');
    if (existente === clave) return false; // ya existe, no duplicar
  }
  sh.appendRow([
    evento.codigo, evento.cliente, evento.tipo, evento.fechaActivacion,
    evento.inicioPeriodo, evento.duracion, evento.precio, evento.nuevoVencimiento
  ]);
  return true;
}

// ---------------------------------------------------------------------------
// Operaciones de ventas
// ---------------------------------------------------------------------------

function nextMemCode_() {
  var values = sheet_(SHEETS.REGISTROS).getDataRange().getValues();
  var max = 0;
  for (var i = 1; i < values.length; i++) {
    var m = String(values[i][0] || '').match(/(\d+)/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  var n = String(max + 1);
  while (n.length < 6) n = '0' + n;
  return 'MEM-' + n;
}

/** Busca la fila (número de fila en la hoja, 1-based) de un código MEM. */
function findRowByCodigo_(codigo) {
  var values = sheet_(SHEETS.REGISTROS).getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]) === String(codigo)) return i + 1;
  }
  return -1;
}

function createSale_(body, actor) {
  var cliente = String(body.cliente || '').trim();
  var correo = String(body.correo || '').trim();
  var duracionMeses = Number(body.duracionMeses);
  var precio = toNumber_(body.precio);
  var fechaInicio = dateStr_(body.fechaInicio) || todayStr_();
  var servicio = String(body.servicio || '').trim() || 'Gemini (Google AI Pro)';
  if (!cliente || !correo) return { ok: false, error: 'Faltan el nombre del cliente o su correo.' };
  if (!duracionMeses || duracionMeses <= 0) return { ok: false, error: 'Duración no válida.' };

  var creado = withLock_(function () {
    bootstrap_();
    var codigo = nextMemCode_();
    var vencimiento = addMonths_(fechaInicio, duracionMeses);
    sheet_(SHEETS.REGISTROS).appendRow([
      codigo, fechaInicio, cliente, correo, vencimiento,
      servicio, duracionLabel_(duracionMeses), precio, 'ACTIVA',
      String(body.correoMembresia || ''), String(body.telefono || ''), 0
    ]);
    appendHistorial_({
      codigo: codigo, cliente: cliente, tipo: 'Compra',
      fechaActivacion: fechaInicio, inicioPeriodo: fechaInicio,
      duracion: duracionLabel_(duracionMeses), precio: precio,
      nuevoVencimiento: vencimiento
    });
    log_(actor, 'Registró venta', codigo + ' · ' + cliente + ' · ' + servicio + ' · ' + duracionLabel_(duracionMeses) + ' · $' + precio);
    return { codigo: codigo, vencimiento: vencimiento };
  });
  return { ok: true, codigo: creado.codigo, fechaVencimiento: creado.vencimiento };
}

function renew_(body, actor) {
  var codigo = String(body.codigo || '').trim();
  var fechaActivacion = dateStr_(body.fechaActivacion) || todayStr_();
  var duracionMeses = Number(body.duracionMeses);
  var precio = toNumber_(body.precio);
  var servicioCortado = body.servicioCortado === true || body.servicioCortado === 'true';
  if (!codigo) return { ok: false, error: 'Falta el código del cliente.' };
  if (!duracionMeses || duracionMeses <= 0) return { ok: false, error: 'Duración no válida.' };

  return withLock_(function () {
    var fila = findRowByCodigo_(codigo);
    if (fila < 0) return { ok: false, error: 'No se encontró el cliente ' + codigo + '.' };
    var sh = sheet_(SHEETS.REGISTROS);
    var filaDatos = sh.getRange(fila, 1, 1, 12).getValues()[0];
    var cliente = String(filaDatos[2] || '');
    var vencimientoAnterior = dateStr_(filaDatos[4]);

    // Regla del negocio: si el servicio NO se cortó, el nuevo periodo
    // arranca el día que venció el anterior; si se cortó, el día de la
    // activación de la renovación.
    var inicioPeriodo = servicioCortado ? fechaActivacion : (vencimientoAnterior || fechaActivacion);
    var nuevoVencimiento = addMonths_(inicioPeriodo, duracionMeses);
    var renovaciones = (Number(filaDatos[11]) || 0) + 1;

    sh.getRange(fila, 2).setValue(inicioPeriodo);          // B Fecha de Inicio
    sh.getRange(fila, 5).setValue(nuevoVencimiento);       // E Fecha de Vencimiento
    sh.getRange(fila, 7).setValue(duracionLabel_(duracionMeses)); // G Duración
    sh.getRange(fila, 8).setValue(precio);                 // H Precio
    sh.getRange(fila, 9).setValue('ACTIVA');               // I Estado
    sh.getRange(fila, 12).setValue(renovaciones);          // L Renovaciones

    appendHistorial_({
      codigo: codigo, cliente: cliente, tipo: 'Renovación',
      fechaActivacion: fechaActivacion, inicioPeriodo: inicioPeriodo,
      duracion: duracionLabel_(duracionMeses), precio: precio,
      nuevoVencimiento: nuevoVencimiento
    });
    log_(actor, 'Renovó', codigo + ' · ' + cliente + ' · renovación #' + renovaciones +
      ' · ' + duracionLabel_(duracionMeses) + ' · $' + precio + ' · vence ' + nuevoVencimiento);
    return { ok: true, codigo: codigo, fechaVencimiento: nuevoVencimiento, renovaciones: renovaciones };
  });
}

function cancel_(body, actor) {
  var codigo = String(body.codigo || '').trim();
  if (!codigo) return { ok: false, error: 'Falta el código del cliente.' };
  return withLock_(function () {
    var fila = findRowByCodigo_(codigo);
    if (fila < 0) return { ok: false, error: 'No se encontró el cliente ' + codigo + '.' };
    var sh = sheet_(SHEETS.REGISTROS);
    var cliente = String(sh.getRange(fila, 3).getValue() || '');
    sh.getRange(fila, 9).setValue('CANCELADA');
    log_(actor, 'Canceló', codigo + ' · ' + cliente);
    return { ok: true, codigo: codigo };
  });
}

// ---------------------------------------------------------------------------
// Gestión de accesos (agregar / quitar personas)
// ---------------------------------------------------------------------------

function addAccess_(body, actor) {
  var email = normalizeEmail_(body.email);
  var nombre = String(body.nombre || '').trim();
  if (!email || email.indexOf('@') < 0) return { ok: false, error: 'Correo no válido.' };
  return withLock_(function () {
    if (isAuthorized_(email)) return { ok: false, error: 'Ese correo ya tiene acceso.' };
    sheet_(SHEETS.ACCESOS).appendRow([email, nombre, actor, nowStr_()]);
    log_(actor, 'Agregó acceso', email + (nombre ? ' · ' + nombre : ''));
    return { ok: true, email: email };
  });
}

function removeAccess_(body, actor) {
  var email = normalizeEmail_(body.email);
  if (!email) return { ok: false, error: 'Falta el correo.' };
  // El acceso del dueño no se puede quitar.
  if (email === OWNER_EMAIL) {
    return { ok: false, error: 'No se puede quitar el acceso al dueño del sistema.' };
  }
  return withLock_(function () {
    var sh = sheet_(SHEETS.ACCESOS);
    var values = sh.getDataRange().getValues();
    for (var i = values.length - 1; i >= 1; i--) {
      if (normalizeEmail_(values[i][0]) === email) {
        sh.deleteRow(i + 1);
        log_(actor, 'Quitó acceso', email);
        return { ok: true, email: email };
      }
    }
    return { ok: false, error: 'Ese correo no estaba en la lista de accesos.' };
  });
}


/**
 * ============================================================
 * COMPATIBILIDAD CON LOS BOTONES DE LA HOJA (INICIO)
 * ------------------------------------------------------------
 * Estas son las funciones ORIGINALES de la hoja, conservadas
 * tal cual para que los botones REGISTRAR VENTA y
 * CANCELAR MEMBRESÍA de la pestaña INICIO sigan funcionando
 * igual que siempre. El sistema web usa las funciones de
 * arriba; estas dos son solo para los botones de la hoja.
 * ============================================================
 */

function registrarVenta() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const inicioSheet = ss.getSheetByName("INICIO");
  const registrosSheet = ss.getSheetByName("REGISTROS");

  // 1. VERIFICAR HOJAS
  if (!inicioSheet || !registrosSheet) {
    SpreadsheetApp.getUi().alert(
      "ERROR: No se encontró la hoja INICIO o REGISTROS."
    );
    return;
  }

  // 2. LEER DATOS DEL FORMULARIO
  const fecha = inicioSheet.getRange("D5").getValue();

  const cliente = String(
    inicioSheet.getRange("D6").getValue()
  ).trim();

  const duracion = String(
    inicioSheet.getRange("D7").getValue()
  ).trim();

  const servicio = String(
    inicioSheet.getRange("D8").getValue()
  ).trim();

  const correo = String(
    inicioSheet.getRange("D9").getValue()
  ).trim();

  const precio = inicioSheet.getRange("D10").getValue();

  // NUEVO: leer el teléfono del formulario
  const telefono = inicioSheet.getRange("D11").getDisplayValue().trim();

  const correoMembresia = String(
    inicioSheet.getRange("D12").getValue()
  ).trim();

  // 3. VALIDAR DATOS
  if (!cliente) {
    SpreadsheetApp.getUi().alert(
      "⚠️ Debes ingresar el Nombre del Cliente."
    );
    return;
  }

  if (!servicio) {
    SpreadsheetApp.getUi().alert(
      "⚠️ Debes seleccionar el Servicio / Membresía."
    );
    return;
  }

  if (!correo) {
    SpreadsheetApp.getUi().alert(
      "⚠️ Debes ingresar el Correo Electrónico."
    );
    return;
  }

  if (!correoMembresia) {
    SpreadsheetApp.getUi().alert(
      "⚠️ Debes ingresar el Correo de Membresía."
    );
    return;
  }

  // 4. EVITAR DOS CÓDIGOS IGUALES
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(10000);
  } catch (error) {
    SpreadsheetApp.getUi().alert(
      "⚠️ El sistema está ocupado. Intenta nuevamente."
    );
    return;
  }

  try {
    // 5. ENCONTRAR LA PRIMERA FILA LIBRE
    const ultimaFila = Math.max(
      registrosSheet.getLastRow(),
      1
    );

    let targetRow = 2;

    for (
      let fila = 2;
      fila <= ultimaFila + 1;
      fila++
    ) {
      const valores = registrosSheet
        .getRange(fila, 1, 1, 10)
        .getValues()[0];

      const filaVacia = valores.every(
        valor => valor === "" || valor === null
      );

      if (filaVacia) {
        targetRow = fila;
        break;
      }
    }

    // 6. GENERAR CÓDIGO ÚNICO
    const codigos = registrosSheet
      .getRange(
        2,
        1,
        Math.max(ultimaFila - 1, 1),
        1
      )
      .getDisplayValues()
      .flat();

    let mayorNumero = 0;

    codigos.forEach(codigo => {
      if (!codigo) return;

      const texto = String(codigo).trim();

      const coincidencia = texto.match(
        /^MEM-(\d+)$/
      );

      if (coincidencia) {
        const numero = parseInt(
          coincidencia[1],
          10
        );

        if (numero > mayorNumero) {
          mayorNumero = numero;
        }
      }
    });

    const nuevoNumero = mayorNumero + 1;

    const codigo = "MEM-" +
      String(nuevoNumero).padStart(6, "0");

    // 7. GUARDAR EL REGISTRO
    // A = Código
    registrosSheet
      .getRange(targetRow, 1)
      .setValue(codigo);

    // B = Fecha de Inicio
    registrosSheet
      .getRange(targetRow, 2)
      .setValue(fecha || new Date());

    // C = Cliente
    registrosSheet
      .getRange(targetRow, 3)
      .setValue(cliente);

    // D = Correo Electrónico
    registrosSheet
      .getRange(targetRow, 4)
      .setValue(correo);

    // 8. FECHA DE VENCIMIENTO
    const formulaVencimiento =
      `=IF(OR(B${targetRow}="",G${targetRow}=""),"",` +
      `EDATE(B${targetRow},` +
      `SWITCH(TRIM(G${targetRow}),` +
      `"1 mes",1,` +
      `"3 meses",3,` +
      `"6 meses",6,` +
      `"12 meses",12,1)))`;

    registrosSheet
      .getRange(targetRow, 5)
      .setFormula(formulaVencimiento);

    // F = Servicio
    registrosSheet
      .getRange(targetRow, 6)
      .setValue(servicio);

    // G = Duración
    registrosSheet
      .getRange(targetRow, 7)
      .setValue(duracion);

    // H = Precio
    registrosSheet
      .getRange(targetRow, 8)
      .setValue(precio);

    // 9. ESTADO AUTOMÁTICO
    const formulaEstado =
      `=IF(OR(B${targetRow}="",E${targetRow}=""),"",` +
      `IF(E${targetRow}<TODAY(),"VENCIDA",` +
      `IF(E${targetRow}<=TODAY()+3,"POR VENCER","ACTIVA")))`;

    registrosSheet
      .getRange(targetRow, 9)
      .setFormula(formulaEstado);

    // J = Correo de Membresía
    registrosSheet
      .getRange(targetRow, 10)
      .setValue(correoMembresia);

    // NUEVO: K = Teléfono / Contacto
    registrosSheet
      .getRange(targetRow, 11)
      .setValue(telefono);

    // 10. APLICAR FORMATO DE LA FILA ANTERIOR
    // Ahora se copia el formato hasta la columna K.
    if (targetRow > 2) {
      registrosSheet
        .getRange(targetRow - 1, 1, 1, 11)
        .copyTo(
          registrosSheet.getRange(
            targetRow,
            1,
            1,
            11
          ),
          SpreadsheetApp.CopyPasteType.PASTE_FORMAT,
          false
        );
    }

    // 11. FORZAR ACTUALIZACIÓN
    SpreadsheetApp.flush();

    // 12. LIMPIAR FORMULARIO
    inicioSheet
      .getRange("D6")
      .clearContent();

    inicioSheet
      .getRange("D8")
      .clearContent();

    inicioSheet
      .getRange("D9")
      .clearContent();

    inicioSheet
      .getRange("D10")
      .clearContent();

    inicioSheet
      .getRange("D11")
      .clearContent();

    inicioSheet
      .getRange("D12")
      .clearContent();

    // Fecha actual
    inicioSheet
      .getRange("D5")
      .setValue(new Date());

    // 13. MOSTRAR REGISTROS
    ss.setActiveSheet(registrosSheet);

    SpreadsheetApp.flush();

    // 14. MENSAJE DE CONFIRMACIÓN
    ss.toast(
      `✅ Venta de "${cliente}" registrada correctamente.\nCódigo: ${codigo}`,
      "REGISTRO EXITOSO",
      5
    );

  } finally {
    lock.releaseLock();
  }
}


function cancelarMembresia() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hojaInicio = ss.getSheetByName("INICIO");
  const hojaRegistros = ss.getSheetByName("REGISTROS");
  const ui = SpreadsheetApp.getUi();

  // El código se toma de I5 en INICIO
  const codigo = hojaInicio.getRange("I5").getValue().toString().trim();

  if (!codigo) {
    ui.alert(
      "Atención",
      "Por favor introduce un código de membresía.",
      ui.ButtonSet.OK
    );
    return;
  }

  const ultimaFila = hojaRegistros.getLastRow();

  if (ultimaFila < 2) {
    ui.alert(
      "Error",
      "No existen registros de membresías.",
      ui.ButtonSet.OK
    );
    return;
  }

  const datos = hojaRegistros
    .getRange(2, 1, ultimaFila - 1, 10)
    .getValues();

  let filaEncontrada = -1;
  let estadoActual = "";

  for (let i = 0; i < datos.length; i++) {
    const codigoRegistro = datos[i][0]
      .toString()
      .trim()
      .toUpperCase();

    if (codigoRegistro === codigo.toUpperCase()) {
      filaEncontrada = i + 2;
      estadoActual = datos[i][8]
        .toString()
        .trim()
        .toUpperCase();
      break;
    }
  }

  if (filaEncontrada === -1) {
    ui.alert(
      "Error",
      "No se encontró ninguna membresía con el código: " + codigo,
      ui.ButtonSet.OK
    );
    return;
  }

  if (estadoActual === "CANCELADA") {
    ui.alert(
      "Aviso",
      "Esta membresía ya se encuentra cancelada.",
      ui.ButtonSet.OK
    );
    return;
  }

  const respuesta = ui.alert(
    "Confirmación",
    "¿Deseas cancelar la membresía " + codigo + "?",
    ui.ButtonSet.YES_NO
  );

  if (respuesta === ui.Button.YES) {
    // Columna I = Estado
    hojaRegistros.getRange(filaEncontrada, 9).setValue("CANCELADA");

    SpreadsheetApp.flush();

    ui.alert(
      "Éxito",
      "La membresía " + codigo + " ha sido cancelada correctamente.",
      ui.ButtonSet.OK
    );
  }
}
