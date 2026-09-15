// legalContent.jsx — textos legales de lixbon (/legal/:doc). Lo que va entre
// corchetes son datos del responsable que hay que rellenar antes de cobrar en
// modo real; el resto describe lo que la plataforma hace de verdad.
import { Link } from 'react-router-dom';
import { LEGAL_INDEX } from './legalIndex';

export const RESPONSABLE = {
  nombre: '[Nombre o razón social del responsable]',
  nit: '[NIT o documento]',
  direccion: '[Dirección], Medellín, Colombia',
  correo: 'privacidad@lixbon.com',
  soporte: 'soporte@lixbon.com',
};

export const VIGENCIA = '15 de septiembre de 2026';

export { LEGAL_INDEX };

function Privacidad() {
  return (
    <>
      <h1>Política de privacidad y tratamiento de datos personales</h1>
      <p className="docs__lead">
        Esta política explica qué datos personales trata lixbon, para qué, durante
        cuánto tiempo y cómo puedes ejercer tus derechos. Se aplica a la web, las
        aplicaciones (CLI, escritorio, Android) y la API. Cumple la Ley 1581 de 2012,
        el Decreto 1377 de 2013 y demás normas colombianas sobre habeas data.
      </p>

      <h2>1. Responsable del tratamiento</h2>
      <ul>
        <li><strong>Responsable:</strong> {RESPONSABLE.nombre} · {RESPONSABLE.nit}</li>
        <li><strong>Domicilio:</strong> {RESPONSABLE.direccion}</li>
        <li><strong>Correo para asuntos de datos personales:</strong> <a href={`mailto:${RESPONSABLE.correo}`}>{RESPONSABLE.correo}</a></li>
      </ul>

      <h2>2. Qué datos tratamos</h2>
      <ul>
        <li><strong>Cuenta:</strong> nombre, apellido, correo electrónico y contraseña (solo se guarda un hash; nunca la contraseña en claro).</li>
        <li><strong>Contenido que nos envías:</strong> mensajes del chat, archivos adjuntos, diseños de Visuals y el código que compartes con el agente del CLI o del IDE. Se guarda solo si tienes activado el historial.</li>
        <li><strong>Uso:</strong> mensajes y tokens por día y modelo, para aplicar los límites de tu plan, mostrarte tu consumo y facturar la API.</li>
        <li><strong>Facturación:</strong> plan, identificador de cliente en Stripe, marca y últimos cuatro dígitos de tus tarjetas, historial de cobros y saldo de créditos. <strong>Nunca el número completo de la tarjeta</strong>: lo recibe Stripe directamente desde tu navegador.</li>
        <li><strong>Técnicos:</strong> dirección IP, navegador y fecha de cada inicio de sesión, y un registro de auditoría de acciones sensibles (cambios de contraseña, pagos, borrado de datos).</li>
        <li><strong>API keys:</strong> el nombre de cada clave y su uso; la clave solo se muestra una vez y se guarda con hash.</li>
      </ul>

      <h2>3. Para qué los usamos (finalidades)</h2>
      <ul>
        <li>Prestar el servicio: autenticarte, responder a tus mensajes, guardar tu historial y tus diseños.</li>
        <li>Gestionar tu plan y cobrarte: suscripciones, recargas de créditos, facturas y correos sobre pagos (alta, renovación, cobro fallido, cancelación).</li>
        <li>Aplicar los límites del plan y prevenir abusos (límites por minuto, bloqueo de intentos de acceso fallidos).</li>
        <li>Atender tus solicitudes de soporte y de derechos sobre tus datos.</li>
        <li>Mejorar el servicio con métricas agregadas y anónimas, solo si dejas activada la opción «Datos de uso anónimos».</li>
        <li>Cumplir obligaciones legales, contables y fiscales.</li>
      </ul>
      <p>
        Tus conversaciones y diseños <strong>no se usan para entrenar modelos</strong> ni se
        venden ni se ceden a terceros con fines comerciales.
      </p>

      <h2>4. Base del tratamiento</h2>
      <p>
        Tratamos tus datos porque nos lo autorizas al crear la cuenta y porque son
        necesarios para prestarte el servicio que contratas. Los datos de facturación y
        los registros de auditoría se conservan además por obligación legal.
      </p>

      <h2>5. Con quién compartimos datos (encargados y transferencias)</h2>
      <p>
        Para funcionar, lixbon usa proveedores que tratan datos por nuestra cuenta y
        que pueden estar fuera de Colombia:
      </p>
      <ul>
        <li><strong>Railway (Estados Unidos):</strong> aloja el servidor y la base de datos.</li>
        <li><strong>Stripe (Estados Unidos):</strong> procesa los pagos y guarda los métodos de pago. Su política: <a href="https://stripe.com/privacy" target="_blank" rel="noreferrer">stripe.com/privacy</a>.</li>
        <li><strong>Nodos de inferencia (GPU):</strong> los modelos se ejecutan en servidores propios o alquilados a proveedores de cómputo (por ejemplo Vast.ai). El contenido de tus mensajes pasa por ellos únicamente para generar la respuesta y no se conserva allí.</li>
        <li><strong>Cloudflare:</strong> protege y acelera el acceso a lixbon.com.</li>
        <li><strong>Proveedor de correo transaccional:</strong> envía los correos de verificación, restablecimiento de contraseña y pagos.</li>
      </ul>
      <p>
        Al aceptar esta política autorizas la transferencia internacional de tus datos a
        esos encargados, que están obligados contractualmente a protegerlos. No
        compartimos tus datos con nadie más salvo requerimiento de una autoridad
        competente.
      </p>

      <h2>6. Cuánto tiempo los conservamos</h2>
      <ul>
        <li>Cuenta, historial y diseños: mientras tu cuenta exista. Puedes borrar el historial cuando quieras.</li>
        <li>Datos de facturación y registros de auditoría: el tiempo que exija la ley contable y fiscal, aunque elimines la cuenta.</li>
        <li>Al eliminar la cuenta se borran tus conversaciones, diseños, claves y datos de perfil, y se cancela tu suscripción en Stripe en ese momento.</li>
      </ul>

      <h2>7. Tus derechos</h2>
      <p>
        Como titular puedes <strong>conocer, actualizar, rectificar y suprimir</strong> tus
        datos, <strong>revocar</strong> la autorización, pedir <strong>prueba</strong> de ella y
        presentar quejas ante la Superintendencia de Industria y Comercio. Puedes
        hacerlo tú mismo desde <Link to="/account/privacidad">Ajustes → Privacidad</Link>
        (exportar tus datos, borrar el historial, eliminar la cuenta) o escribiendo a{' '}
        <a href={`mailto:${RESPONSABLE.correo}`}>{RESPONSABLE.correo}</a>. Respondemos las
        consultas en un máximo de diez (10) días hábiles y los reclamos en quince (15),
        conforme a la ley.
      </p>

      <h2>8. Seguridad</h2>
      <ul>
        <li>Todo el tráfico va cifrado (HTTPS). Las contraseñas y las API keys se guardan con hash.</li>
        <li>Los datos de tarjeta los recogen campos servidos por Stripe: no pasan por nuestros servidores (cuestionario PCI SAQ A).</li>
        <li>Los enlaces públicos de conversaciones y diseños solo existen si tú los creas, y puedes desactivarlos al instante.</li>
        <li>Acceso al panel de administración restringido y registrado.</li>
      </ul>

      <h2>9. Cookies</h2>
      <p>
        lixbon usa únicamente una cookie de sesión, necesaria para mantenerte
        identificado, y el almacenamiento local del navegador para preferencias de la
        interfaz. No usamos cookies de publicidad ni de seguimiento de terceros.
      </p>

      <h2>10. Menores de edad</h2>
      <p>
        El servicio está dirigido a mayores de 18 años. Si detectamos una cuenta de un
        menor sin autorización de su representante, la eliminaremos.
      </p>

      <h2>11. Cambios</h2>
      <p>
        Si cambiamos esta política te avisaremos por correo o en la aplicación con
        antelación razonable. Vigente desde el {VIGENCIA}.
      </p>
    </>
  );
}

function Terminos() {
  return (
    <>
      <h1>Términos y condiciones de uso</h1>
      <p className="docs__lead">
        Al crear una cuenta en lixbon aceptas estos términos. Léelos: describen qué
        contratas, qué puedes hacer con el servicio y qué responsabilidad asumimos.
      </p>

      <h2>1. El servicio</h2>
      <p>
        lixbon es una plataforma de inteligencia artificial que ofrece chat con modelos
        de lenguaje, generación de diseños (Visuals), herramientas de programación (CLI y
        app de escritorio), control remoto de sesiones (Remote) y una API compatible con
        OpenAI. Lo presta {RESPONSABLE.nombre} ({RESPONSABLE.nit}), con domicilio en{' '}
        {RESPONSABLE.direccion}.
      </p>

      <h2>2. Tu cuenta</h2>
      <ul>
        <li>Debes ser mayor de 18 años y dar datos veraces.</li>
        <li>Eres responsable de tu contraseña y de tus API keys. Si crees que alguien las tiene, cámbialas o revócalas desde Ajustes.</li>
        <li>Una cuenta es personal; no la compartas ni la revendas.</li>
      </ul>

      <h2>3. Planes, límites y pagos</h2>
      <ul>
        <li>El plan Gratuito y los planes de pago (Pro, Advance) tienen los límites publicados en <Link to="/planes">Planes</Link> y en la <Link to="/docs/planes">documentación</Link>. Podemos ajustar límites y precios avisando con antelación; el cambio aplica a partir de la siguiente renovación.</li>
        <li>Los planes de pago se cobran <strong>por adelantado cada mes</strong> con la tarjeta que registres, a través de Stripe, y se renuevan solos hasta que canceles.</li>
        <li>Al mejorar de plan se cobra en el momento la diferencia proporcional al tiempo que queda del mes; al bajar no se cobra nada y lo no consumido se descuenta de las siguientes facturas.</li>
        <li>El uso de la API con clave se paga con <strong>créditos prepago</strong> según los tokens consumidos y las <Link to="/docs/precios-api">tarifas publicadas</Link>. Solo se cobran los modelos que aparecen en esa tabla.</li>
        <li>Los precios están en dólares estadounidenses (USD). Los impuestos que apliquen según tu país pueden sumarse al precio.</li>
        <li>Si un cobro falla, Stripe lo reintenta durante unos días; si no entra, la suscripción se cancela y la cuenta pasa al plan Gratuito.</li>
        <li>Cancelaciones y reembolsos: ver la <Link to="/legal/reembolsos">política de cancelaciones y reembolsos</Link>.</li>
      </ul>

      <h2>4. Uso aceptable</h2>
      <p>No puedes usar lixbon para:</p>
      <ul>
        <li>Actividades ilegales, fraude, acoso, o generar contenido que explote a menores, incite a la violencia o infrinja derechos de terceros.</li>
        <li>Crear malware, atacar sistemas ajenos o eludir los límites del servicio (por ejemplo, repartiendo el tráfico entre varias cuentas).</li>
        <li>Revender el acceso o hacer scraping masivo de las respuestas.</li>
      </ul>
      <p>
        Podemos suspender o cerrar una cuenta que incumpla estas reglas. Si es posible,
        te avisaremos antes.
      </p>

      <h2>5. Contenido y propiedad</h2>
      <ul>
        <li>Lo que envías (mensajes, archivos, código, diseños) sigue siendo tuyo. Nos das permiso solo para procesarlo y guardarlo con el fin de prestarte el servicio.</li>
        <li>Las respuestas y diseños generados son tuyos para usarlos como quieras, dentro de las licencias de los modelos de código abierto que los generan.</li>
        <li>lixbon, su marca, su software y su interfaz son de {RESPONSABLE.nombre}.</li>
      </ul>

      <h2>6. Contenido generado por inteligencia artificial</h2>
      <p>
        Los modelos pueden equivocarse, inventar datos o producir código con errores.
        Las respuestas se entregan «tal cual», sin garantía de exactitud, y no
        constituyen asesoría legal, médica, financiera ni de ningún otro tipo. Revisa lo
        que generes antes de usarlo, sobre todo si vas a ejecutar código o tomar
        decisiones con él. En el modo agente del CLI y del IDE, el modelo edita archivos
        y ejecuta comandos en tu máquina con tu aprobación: la responsabilidad de
        aprobarlos es tuya.
      </p>

      <h2>7. Disponibilidad</h2>
      <p>
        Hacemos lo posible por mantener el servicio disponible, pero depende de
        infraestructura de terceros (nube, GPU alquiladas, pasarela de pago) y puede
        interrumpirse por mantenimiento o incidentes. Los planes no incluyen un
        compromiso de disponibilidad garantizada (SLA).
      </p>

      <h2>8. Limitación de responsabilidad</h2>
      <p>
        En la medida en que la ley lo permita, lixbon no responde por daños indirectos,
        lucro cesante o pérdida de datos derivados del uso del servicio o de su
        interrupción. Nuestra responsabilidad total frente a ti se limita a lo que hayas
        pagado en los tres (3) meses anteriores al hecho que la origine. Nada de lo
        anterior limita los derechos que te reconoce la ley colombiana como consumidor.
      </p>

      <h2>9. Terminación</h2>
      <p>
        Puedes eliminar tu cuenta cuando quieras desde Ajustes → Privacidad. Nosotros
        podemos cerrarla por incumplimiento de estos términos o por cese del servicio,
        avisando con antelación razonable y sin perjuicio de lo pagado por adelantado
        según la política de reembolsos.
      </p>

      <h2>10. Ley aplicable y contacto</h2>
      <p>
        Estos términos se rigen por las leyes de la República de Colombia. Para
        cualquier consulta escribe a <a href={`mailto:${RESPONSABLE.soporte}`}>{RESPONSABLE.soporte}</a>.
        Vigentes desde el {VIGENCIA}.
      </p>
    </>
  );
}

function Reembolsos() {
  return (
    <>
      <h1>Cancelaciones y reembolsos</h1>
      <p className="docs__lead">
        Lo que pasa con tu dinero cuando cancelas, cambias de plan o algo sale mal con
        un cobro.
      </p>

      <h2>Cancelar un plan</h2>
      <ul>
        <li>Cancelas cuando quieras desde <Link to="/account/facturacion">Ajustes → Facturación</Link>, sin llamadas ni correos.</li>
        <li>El plan sigue activo <strong>hasta el final del periodo ya pagado</strong>; después pasas al Gratuito. No se vuelve a cobrar.</li>
        <li>Mientras no llegue esa fecha puedes reactivarlo con un clic.</li>
      </ul>

      <h2>Cambiar de plan</h2>
      <ul>
        <li><strong>Subir:</strong> se cobra en el momento solo la parte proporcional de la diferencia por los días que quedan del mes.</li>
        <li><strong>Bajar:</strong> no se cobra nada; el valor no consumido del plan superior queda a tu favor y se descuenta de las siguientes facturas.</li>
      </ul>

      <h2>Reembolsos</h2>
      <ul>
        <li>Los periodos ya cobrados <strong>no se reembolsan</strong> por cancelación o falta de uso: por eso el plan se mantiene activo hasta que termine el mes pagado.</li>
        <li>Sí reembolsamos íntegramente un cobro <strong>duplicado o erróneo</strong>, o un periodo en el que el servicio haya estado indisponible de forma sustancial por causa nuestra. Escríbenos a <a href={`mailto:${RESPONSABLE.soporte}`}>{RESPONSABLE.soporte}</a> con la referencia del cobro (la ves en Facturación); lo revisamos en un máximo de cinco (5) días hábiles y el abono llega a la misma tarjeta en 5–10 días según tu banco.</li>
        <li>Si tienes derecho de retracto según la ley colombiana (Ley 1480 de 2011) por una compra a distancia, puedes ejercerlo dentro de los cinco (5) días hábiles siguientes al primer cobro de una suscripción nueva, siempre que no hayas hecho un uso sustancial del plan.</li>
      </ul>

      <h2>Créditos de la API</h2>
      <ul>
        <li>Las recargas son pagos únicos. El saldo <strong>no caduca</strong> y solo se descuenta por el uso real de la API.</li>
        <li>El saldo no consumido <strong>no se reembolsa</strong> en dinero, salvo cobro erróneo o cierre del servicio por nuestra parte.</li>
        <li>Si eliminas la cuenta, el saldo restante se pierde; consúmelo antes.</li>
      </ul>

      <h2>Cobros fallidos y disputas</h2>
      <p>
        Si tu banco rechaza una renovación, te avisamos por correo con un enlace para
        pagar o cambiar la tarjeta; el plan sigue activo mientras Stripe reintenta. Antes
        de abrir una disputa con tu banco, escríbenos: resolvemos los cobros erróneos
        más rápido que un contracargo.
      </p>

      <p>Vigente desde el {VIGENCIA}.</p>
    </>
  );
}

const CUERPOS = { privacidad: Privacidad, terminos: Terminos, reembolsos: Reembolsos };

export const LEGAL = LEGAL_INDEX.map((d) => ({ ...d, Body: CUERPOS[d.id] }));
