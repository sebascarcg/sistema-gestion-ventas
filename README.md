# Sistema de Gestión de Ventas y Membresías

Sistema web para llevar las ventas de membresías **Gemini (Google AI Pro)**:
clientes, vencimientos, renovaciones con historial, cola de urgencia con
botón de WhatsApp, control de accesos y bitácora de quién hizo cada cambio.

Precios de referencia (COP): 1 mes $15.000 · 3 meses $30.000 ·
6 meses $50.000 · 1 año $80.000.

## Arquitectura

```
GitHub Pages (frontend estático)        Google Apps Script (backend)        Google Sheets
index.html + config.js   ── POST JSON ──▶  backend/apps-script.gs  ───────▶  Hoja "SISTEMA DE
(solo guarda el token                      (único que toca la hoja            GESTIÓN DE VENTAS
en sessionStorage)                          y envía los códigos)              Y MEMBRESÍAS"
```

- **Frontend** (`index.html`, `config.js`): página estática publicada con
  GitHub Pages. No contiene datos ni secretos; solo la URL del Web App.
- **Backend** (`backend/apps-script.gs`): proyecto de Google Apps Script
  vinculado a la hoja, desplegado como **Web App**. Valida la sesión,
  aplica las reglas del negocio y escribe en la hoja.
- **Datos**: viven únicamente en la hoja de cálculo, que sigue siendo la
  base de verdad. Pestañas que usa el sistema:
  - `REGISTROS` — una fila por cliente (código MEM único).
  - `HISTORIAL` — compra inicial y cada renovación (escritura idempotente:
    nunca duplica un evento con la misma clave).
  - `ACCESOS` — correos autorizados para entrar (se crea sola si falta).
  - `BITACORA` — quién hizo qué y cuándo (se crea sola si falta).
  - `SESIONES` — oculta, guarda *hashes* de los tokens de sesión.
  - `POR VENCER` y `VENCIDAS` son fórmulas de la hoja: el sistema **nunca**
    escribe en ellas.

## Cómo funciona el ingreso (login)

1. La persona escribe su correo en la página.
2. Si el correo está en `ACCESOS`, el backend le envía un **código de
   6 dígitos** a su Gmail (válido 10 minutos, un solo uso, máximo
   5 intentos). Si el correo no está autorizado, la respuesta es genérica
   y no se envía nada.
3. Al verificar el código, el backend entrega un **token de sesión**
   (válido 12 horas) que el navegador guarda en `sessionStorage`.
4. Cada operación registra en la BITÁCORA el correo de la sesión que la
   hizo, así siempre se sabe quién registró, renovó, canceló o cambió
   accesos.

Correos autorizados iniciales (se siembran solos si `ACCESOS` está vacía):
el dueño y los agentes definidos en `BOOTSTRAP_ACCESOS` dentro de
`backend/apps-script.gs`. Después, los accesos se manejan desde la propia
página, en la sección **Accesos** (botón *Agregar persona* y botón
*Quitar acceso*; el acceso del dueño no se puede quitar).

## Pasos de despliegue

1. **Crear el repositorio y subir estos archivos**
   - Crea un repositorio en GitHub y sube el contenido de esta carpeta
     (`index.html`, `config.js`, `README.md` y `backend/`).

2. **Activar GitHub Pages**
   - En el repositorio: *Settings → Pages → Build and deployment →
     Source: Deploy from a branch*, rama `main`, carpeta raíz (`/`).
   - GitHub te dará la URL pública de la página (algo como
     `https://TU-USUARIO.github.io/TU-REPO/`).

3. **Instalar el backend en la hoja**
   - Abre la hoja "SISTEMA DE GESTIÓN DE VENTAS Y MEMBRESÍAS".
   - Menú *Extensiones → Apps Script*.
   - Borra el contenido de ejemplo y pega todo el archivo
     `backend/apps-script.gs`.
   - (Opcional, recomendado) Ejecuta una vez la función `setupInicial`
     desde el editor: crea las pestañas `ACCESOS`, `BITACORA`,
     `HISTORIAL` (si faltan) y siembra los correos autorizados.
   - Botón *Implementar → Nueva implementación → Aplicación web*:
     - **Ejecutar como:** Yo (Me)
     - **Quién tiene acceso:** Cualquier persona (Anyone)
   - Autoriza los permisos que pida (leer/escribir la hoja y enviar
     correos con tu cuenta) y copia la **URL del Web App** (termina en
     `/exec`).

4. **Conectar el frontend con el backend**
   - Edita `config.js` y reemplaza `PEGAR_URL_DEL_WEB_APP_AQUI` por la
     URL del Web App del paso 3.
   - Sube ese cambio al repositorio. GitHub Pages se actualiza solo en
     unos minutos.

5. **Entrar por primera vez**
   - Abre la URL de GitHub Pages desde cualquier dispositivo.
   - Escribe uno de los correos autorizados, pide el código, revísalo en
     tu Gmail y escríbelo en la página. Ya estás dentro.

### Cuando cambies el backend

Cada vez que edites `apps-script.gs`, hay que volver a desplegar:
*Implementar → Gestionar implementaciones → editar (lápiz) → Versión:
Nueva versión → Implementar*. Si editas sobre la misma implementación, la
URL del Web App no cambia y no hay que tocar `config.js`.

## Notas de seguridad

- El repositorio **puede ser público**: no contiene datos de clientes ni
  secretos. La URL del Web App tampoco es un secreto, porque sin un token
  de sesión válido el backend no entrega ningún dato, y los códigos solo
  llegan a los correos de la lista de accesos.
- Los datos personales viven solo en la hoja de cálculo, con el acceso
  normal de Google.
- Los códigos de ingreso se guardan *hasheados* y vencen en 10 minutos;
  los tokens de sesión se guardan *hasheados* y vencen en 12 horas.
- Quitar un acceso desde la página impide que ese correo reciba nuevos
  códigos de inmediato.
- Respaldo recomendado: haz una copia de la hoja de cálculo antes de
  cambios grandes (*Archivo → Hacer una copia* en Google Sheets).

## Funciones del panel

- **Contadores**: activas, por vencer, vencidas y canceladas.
- **Cola de urgencia**: clientes vencidos y por vencer, con botón verde de
  **WhatsApp** que abre el mensaje de renovación ya escrito (personalizado
  con nombre y fecha, y con los planes y precios).
- **Clientes**: buscador y filtros por estado; cada cliente muestra su
  chip "Renovaciones: N".
- **Ficha del cliente**: datos completos, historial de compra y
  renovaciones, botones **Renovar** (mismo registro, sin duplicar al
  cliente: se pone la fecha de activación, el plan y si el servicio se
  cortó o no) y **Cancelar**.
- **Registrar venta**: formulario corto; el código MEM se asigna solo.
- **Accesos**: agregar o quitar personas autorizadas.
- **Bitácora**: las últimas 100 acciones con usuario, fecha y detalle.
