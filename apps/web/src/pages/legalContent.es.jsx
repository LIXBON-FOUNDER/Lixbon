// legalContent.es.jsx — textos legales de lixbon en español (/legal/:doc). Lo
// que va entre corchetes son datos del responsable que hay que rellenar antes
// de cobrar en modo real; el resto describe lo que la plataforma hace de verdad.
import { Link } from '../i18n/link';
import { RESPONSABLE, VIGENCIA as VIGENCIA_POR_IDIOMA } from './legalShared';

const VIGENCIA = VIGENCIA_POR_IDIOMA.es;

function Privacidad() {
  return (
    <>
      <h1>Política de privacidad</h1>
      <p className="docs__lead">
        Aquí te contamos, sin rodeos, qué datos tuyos guarda lixbon, para qué los usa,
        con quién los comparte y cómo puedes pedir que los cambiemos o los borremos.
        Vale para la web, las aplicaciones y la API, y sigue la ley colombiana de
        protección de datos (Ley 1581 de 2012).
      </p>

      <h2>Quién es responsable de tus datos</h2>
      <p>
        {RESPONSABLE.nombre} ({RESPONSABLE.nit}), con dirección en {RESPONSABLE.direccion}.
        Para cualquier asunto sobre tus datos escríbenos a{' '}
        <a href={`mailto:${RESPONSABLE.correo}`}>{RESPONSABLE.correo}</a>.
      </p>

      <h2>Qué datos guardamos</h2>
      <ul>
        <li><strong>Tu cuenta:</strong> nombre, apellido, correo y contraseña. La contraseña se guarda protegida, de forma que ni nosotros podemos leerla.</li>
        <li><strong>Lo que escribes:</strong> tus conversaciones, los archivos que adjuntas, los diseños que haces en Visuals y el código que compartes con el agente. Solo se guarda si tienes activado el historial; si lo apagas, los chats nuevos no quedan registrados.</li>
        <li><strong>Cuánto usas lixbon:</strong> cuántos mensajes y cuántos tokens consumes cada día, y con qué modelo. Nos sirve para aplicar los límites de tu plan, enseñarte tu consumo y cobrar el uso de la API.</li>
        <li><strong>Pagos:</strong> tu plan, tu número de cliente en Stripe, la marca y los últimos cuatro dígitos de tus tarjetas, tus cobros y tu saldo de créditos. El número completo de la tarjeta nunca llega a lixbon: lo recibe Stripe directamente desde tu navegador.</li>
        <li><strong>Datos técnicos:</strong> la dirección IP y el navegador con los que inicias sesión, y un registro de acciones importantes (cambiar la contraseña, pagar, borrar datos) por si algún día hay que aclarar qué pasó.</li>
        <li><strong>API keys:</strong> el nombre de cada clave y lo que consume. La clave en sí solo se muestra una vez y se guarda protegida.</li>
      </ul>

      <h2>Para qué los usamos</h2>
      <ul>
        <li>Para que lixbon funcione: reconocerte al entrar, responder a tus mensajes, guardar tu historial y tus diseños.</li>
        <li>Para gestionar tu plan y cobrarte, y para avisarte por correo cuando algo pase con un pago (alta, renovación, cobro fallido, cancelación).</li>
        <li>Para aplicar los límites de tu plan y frenar abusos.</li>
        <li>Para atender tus mensajes de soporte y tus solicitudes sobre tus datos.</li>
        <li>Para mejorar el servicio con estadísticas anónimas, solo si dejas activada la opción «Datos de uso anónimos» en Ajustes.</li>
        <li>Para cumplir las obligaciones legales, contables y fiscales que nos tocan.</li>
      </ul>
      <p>
        Tus conversaciones y tus diseños son tuyos. <strong>No los usamos para entrenar
        modelos</strong>, no los vendemos y no se los cedemos a nadie con fines comerciales.
      </p>

      <h2>Con quién compartimos datos</h2>
      <p>
        Para funcionar, lixbon se apoya en algunos proveedores. Solo reciben lo que
        necesitan para hacer su parte, y varios están fuera de Colombia:
      </p>
      <ul>
        <li><strong>Railway</strong> (Estados Unidos): aloja el servidor y la base de datos.</li>
        <li><strong>Stripe</strong> (Estados Unidos): procesa los pagos y guarda tus tarjetas. Su política de privacidad está en <a href="https://stripe.com/privacy" target="_blank" rel="noreferrer">stripe.com/privacy</a>.</li>
        <li><strong>Servidores con GPU</strong>, propios o alquilados (por ejemplo, en Vast.ai): ahí corren los modelos. Tus mensajes pasan por ellos solo el tiempo necesario para generar la respuesta y no se quedan guardados allí.</li>
        <li><strong>Cloudflare</strong>: protege y acelera el acceso a lixbon.com.</li>
        <li><strong>Un servicio de correo</strong>: envía los correos de verificación, de restablecer la contraseña y de pagos.</li>
      </ul>
      <p>
        Al aceptar esta política nos autorizas a enviar tus datos a esos proveedores,
        que están obligados por contrato a protegerlos. Fuera de ellos, solo
        entregaríamos datos si nos lo exige una autoridad con competencia para hacerlo.
      </p>

      <h2>Cuánto tiempo los guardamos</h2>
      <ul>
        <li>Tu cuenta, tu historial y tus diseños, mientras tengas la cuenta. El historial lo puedes borrar cuando quieras.</li>
        <li>Los datos de pagos y el registro de acciones, el tiempo que exige la ley contable y fiscal, aunque elimines la cuenta.</li>
        <li>Si eliminas la cuenta, borramos tus conversaciones, diseños, claves y datos de perfil, y cancelamos tu suscripción en Stripe en ese momento.</li>
      </ul>

      <h2>Tus derechos</h2>
      <p>
        Puedes ver, corregir y borrar tus datos, retirar la autorización que nos diste,
        pedirnos una copia de ella y, si crees que no te hemos atendido bien, quejarte
        ante la Superintendencia de Industria y Comercio. Casi todo lo puedes hacer tú
        mismo desde <Link to="/account/privacy">Ajustes → Privacidad</Link>: descargar
        tus datos, borrar el historial o eliminar la cuenta. Para lo demás, escríbenos a{' '}
        <a href={`mailto:${RESPONSABLE.correo}`}>{RESPONSABLE.correo}</a>: respondemos las
        consultas en diez días hábiles como mucho, y los reclamos en quince.
      </p>

      <h2>Cómo los protegemos</h2>
      <ul>
        <li>Todo lo que viaja entre tu dispositivo y lixbon va cifrado.</li>
        <li>Las contraseñas y las API keys se guardan de forma que no se pueden leer, ni siquiera desde dentro.</li>
        <li>Los datos de tu tarjeta los escribes en un formulario que sirve Stripe: no pasan por nuestros servidores.</li>
        <li>Una conversación o un diseño solo se puede ver desde fuera si tú creas su enlace público, y puedes desactivarlo al instante.</li>
        <li>El acceso al panel de administración está restringido y queda registrado.</li>
      </ul>

      <h2>Cookies</h2>
      <p>
        Usamos una sola cookie, la que mantiene tu sesión abierta, y el almacenamiento
        del navegador para recordar tus preferencias de la interfaz. No hay cookies de
        publicidad ni de seguimiento.
      </p>

      <h2>Menores de edad</h2>
      <p>
        lixbon es para mayores de 18 años. Si detectamos la cuenta de un menor sin
        permiso de sus padres o tutores, la eliminaremos.
      </p>

      <h2>Cambios en esta política</h2>
      <p>
        Si la cambiamos, te lo diremos por correo o dentro de la aplicación con tiempo.
        Esta versión está vigente desde el {VIGENCIA}.
      </p>
    </>
  );
}

function Terminos() {
  return (
    <>
      <h1>Términos y condiciones</h1>
      <p className="docs__lead">
        Al crear una cuenta aceptas estas condiciones. Están escritas para que se
        entiendan: qué te ofrecemos, qué esperamos de ti y hasta dónde llega nuestra
        responsabilidad.
      </p>

      <h2>Qué es lixbon</h2>
      <p>
        Una plataforma de inteligencia artificial con chat, diseño de webs (Visuals),
        herramientas para programar (CLI y app de escritorio), control de sesiones desde
        el móvil (Remote) y una API compatible con OpenAI. La ofrece{' '}
        {RESPONSABLE.nombre} ({RESPONSABLE.nit}), con dirección en {RESPONSABLE.direccion}.
      </p>

      <h2>Tu cuenta</h2>
      <ul>
        <li>Tienes que ser mayor de 18 años y darnos datos reales.</li>
        <li>Tu contraseña y tus API keys son tu responsabilidad. Si crees que alguien las tiene, cámbialas o revócalas desde Ajustes.</li>
        <li>La cuenta es tuya y de nadie más: no la compartas ni la revendas.</li>
      </ul>

      <h2>Planes, límites y pagos</h2>
      <ul>
        <li>Cada plan tiene los límites que ves en <Link to="/plans">Planes</Link> y en la <Link to="/docs/plans">documentación</Link>. Si cambiamos precios o límites te avisaremos antes, y el cambio aplicará a partir de tu siguiente renovación.</li>
        <li>Los planes de pago se cobran cada mes por adelantado, con la tarjeta que registres, a través de Stripe. Se renuevan solos hasta que canceles.</li>
        <li>Si subes de plan, hoy pagas solo la diferencia por los días que quedan del mes. Si bajas, no pagas nada y lo que te sobra se descuenta de las próximas facturas.</li>
        <li>Usar la API con una clave se paga con créditos que compras antes, según los tokens que consumas y los <Link to="/docs/api-pricing">precios publicados</Link>. Solo se cobran los modelos que aparecen en esa tabla.</li>
        <li>Los precios están en dólares. Según tu país, pueden sumarse impuestos.</li>
        <li>Si un cobro falla, Stripe lo vuelve a intentar durante unos días. Si no entra, la suscripción se cancela y tu cuenta pasa al plan Gratuito.</li>
        <li>Lo que pasa cuando cancelas o quieres un reembolso está en <Link to="/legal/refunds">Cancelaciones y reembolsos</Link>.</li>
      </ul>

      <h2>Lo que no puedes hacer</h2>
      <ul>
        <li>Usar lixbon para actividades ilegales, para acosar a alguien o para generar contenido que explote a menores, incite a la violencia o viole derechos de otros.</li>
        <li>Crear software malicioso, atacar sistemas ajenos o saltarte los límites del servicio (por ejemplo, repartiendo el uso entre varias cuentas).</li>
        <li>Revender el acceso o extraer respuestas de forma masiva y automatizada.</li>
      </ul>
      <p>
        Si alguien incumple estas reglas podemos suspender o cerrar su cuenta. Siempre
        que sea posible, avisaremos antes.
      </p>

      <h2>De quién es cada cosa</h2>
      <ul>
        <li>Lo que envías (mensajes, archivos, código, diseños) sigue siendo tuyo. Solo nos das permiso para procesarlo y guardarlo con el fin de darte el servicio.</li>
        <li>Las respuestas y los diseños que generes también son tuyos, dentro de lo que permitan las licencias de los modelos de código abierto que los producen.</li>
        <li>La marca lixbon, el software y la interfaz son de {RESPONSABLE.nombre}.</li>
      </ul>

      <h2>Lo que genera la inteligencia artificial</h2>
      <p>
        Los modelos se equivocan: pueden inventar datos o escribir código con errores.
        Lo que generan se entrega tal cual, sin garantía de que sea correcto, y no es
        consejo legal, médico ni financiero. Revísalo antes de usarlo, sobre todo si vas
        a ejecutar código o a tomar decisiones con ello. En el modo agente del CLI y de
        la app de escritorio, el modelo edita archivos y ejecuta comandos en tu máquina
        con tu aprobación: decidir qué aprobar es cosa tuya.
      </p>

      <h2>Disponibilidad</h2>
      <p>
        Hacemos lo posible para que lixbon esté siempre disponible, pero dependemos de
        otros (la nube, las GPU alquiladas, la pasarela de pago) y puede haber cortes
        por mantenimiento o por incidentes. Los planes no incluyen un compromiso de
        disponibilidad garantizada.
      </p>

      <h2>Responsabilidad</h2>
      <p>
        Hasta donde la ley lo permite, lixbon no responde por daños indirectos, pérdida
        de ingresos o pérdida de datos que vengan de usar el servicio o de que deje de
        funcionar. Si en algún caso tuviéramos que responder, el tope sería lo que hayas
        pagado en los tres meses anteriores. Nada de esto recorta los derechos que te da
        la ley colombiana como consumidor.
      </p>

      <h2>Cerrar la cuenta</h2>
      <p>
        Puedes eliminar tu cuenta cuando quieras desde Ajustes → Privacidad. Nosotros
        podemos cerrarla si incumples estas condiciones o si dejamos de prestar el
        servicio; en ese caso te avisaremos con tiempo y aplicaremos la política de
        reembolsos a lo que hayas pagado por adelantado.
      </p>

      <h2>Ley aplicable y contacto</h2>
      <p>
        Estas condiciones se rigen por las leyes de Colombia. Si tienes dudas, escríbenos
        a <a href={`mailto:${RESPONSABLE.soporte}`}>{RESPONSABLE.soporte}</a>. Vigentes
        desde el {VIGENCIA}.
      </p>
    </>
  );
}

function Reembolsos() {
  return (
    <>
      <h1>Cancelaciones y reembolsos</h1>
      <p className="docs__lead">
        Qué pasa con tu dinero cuando cancelas, cambias de plan o un cobro sale mal.
      </p>

      <h2>Cancelar el plan</h2>
      <ul>
        <li>Cancelas cuando quieras desde <Link to="/account/billing">Ajustes → Facturación</Link>. Sin llamadas ni correos.</li>
        <li>El plan sigue activo hasta que termine el mes que ya pagaste. Después pasas al Gratuito y no se te vuelve a cobrar.</li>
        <li>Si cambias de idea antes de esa fecha, lo reactivas con un clic.</li>
      </ul>

      <h2>Cambiar de plan</h2>
      <ul>
        <li><strong>Subir:</strong> hoy pagas solo la diferencia por los días que quedan del mes.</li>
        <li><strong>Bajar:</strong> no pagas nada. Lo que te sobra del plan más caro queda a tu favor y se descuenta de las próximas facturas.</li>
      </ul>

      <h2>Cuándo devolvemos el dinero</h2>
      <ul>
        <li>Los meses ya cobrados no se devuelven por cancelar o por no haber usado el plan. Por eso el plan sigue activo hasta que termine el mes.</li>
        <li>Sí devolvemos el importe completo si te cobramos dos veces o por error, o si el servicio estuvo caído buena parte del mes por culpa nuestra. Escríbenos a <a href={`mailto:${RESPONSABLE.soporte}`}>{RESPONSABLE.soporte}</a> con la referencia del cobro (la ves en Facturación). Lo revisamos en cinco días hábiles como mucho, y el abono llega a la misma tarjeta en unos 5 a 10 días, según tu banco.</li>
        <li>Si compras un plan por primera vez y te arrepientes, la ley colombiana te da cinco días hábiles desde el primer cobro para retractarte, siempre que no hayas usado el plan de forma sustancial.</li>
      </ul>

      <h2>Créditos de la API</h2>
      <ul>
        <li>Las recargas son pagos únicos. El saldo no caduca y solo baja cuando usas la API.</li>
        <li>El saldo que no uses no se devuelve en dinero, salvo que el cobro haya sido un error o que cerremos el servicio.</li>
        <li>Si eliminas la cuenta, el saldo que quede se pierde. Gástalo antes.</li>
      </ul>

      <h2>Cobros fallidos y disputas</h2>
      <p>
        Si tu banco rechaza una renovación, te mandamos un correo con un enlace para
        pagar o cambiar de tarjeta, y el plan sigue activo mientras Stripe lo reintenta.
        Antes de abrir una disputa con tu banco, escríbenos: un cobro erróneo lo
        arreglamos más rápido que un contracargo.
      </p>

      <p>Vigente desde el {VIGENCIA}.</p>
    </>
  );
}

const CUERPOS = { privacy: Privacidad, terms: Terminos, refunds: Reembolsos };

export { CUERPOS };
