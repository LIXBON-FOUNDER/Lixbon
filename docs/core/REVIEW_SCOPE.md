# Reparto de revisión · LXO-237

Un reparto fija el Attempt actual y terminado y su HEAD exacto. No lanza modelos
ni acepta automáticamente. Se pueden asignar 1–8 revisores y hasta 256 archivos.
El adversario sigue pudiendo examinar el conjunto completo; ese examen no
sustituye los informes asignados ni constituye aceptación.

## Crear el reparto

`lxo review-scope --config plan.json --confirm` llama a `review_scope`:

```json
{
  "request_id": "review-plan-1",
  "attempt_id": "t1-a1",
  "head_commit": "HEAD completo que se revisó",
  "reviewers": ["task-revisor-1", "task-revisor-2", "task-revisor-3"],
  "assignments": null
}
```

Sin assignments se reparten todos los archivos cambiados de forma determinista
y equilibrada. Con assignments se declara una lista `{reviewer_id, files}` por
revisor, en el mismo orden. Los archivos deben pertenecer al diff completo,
obtenido con Git y separadores NUL. Los huecos y solapes se conservan visibles;
un archivo solapado se considera sin cubrir para aceptar.

Solo una Person autenticada de Desktop/CLI puede crear un reparto, con policy
review y confirmación. La clave request_id es idempotente; cambiar su contenido
produce conflicto. Un reparto nuevo invalida la cobertura del anterior, incluso
con el mismo HEAD. Tras aceptar se congela el reparto; para cambiarlo hay que
rechazar la revisión o trabajar sobre un HEAD nuevo.

## Entregar el informe

Cada agente usa su propia credencial y `lxo review-report --config report.json`:

```json
{
  "request_id": "report-1",
  "attempt_id": "t1-a1",
  "scope_id": "rs-id devuelto al crear el reparto",
  "part": 0,
  "head_commit": "HEAD completo del reparto",
  "files": ["src/login.rs"],
  "summary": "Resultado de la revisión de estos archivos"
}
```

El reviewer_id sale de la credencial Agent (su Task), no del JSON. Un informe no
puede cubrir archivos ajenos a su parte. Para revisión humana manual se asigna
`person:<id autenticado>` y esa persona entrega su informe con la credencial
Desktop/CLI correspondiente. Una persona no suplanta un informe de un agente.
La credencial y la superficie se comprueban en Core. Los informes no conceden
permisos para aceptar, integrar ni lanzar trabajo.

Se permiten informes parciales: solo cuentan los archivos declarados. El último
informe de cada parte sustituye al anterior. Repetir clave y contenido no duplica;
cambiar contenido con la misma clave es conflicto. Los resúmenes se redactan y
acotan a 2000 bytes. La procedencia sigue siendo declarada por el revisor.

## Consultar y decidir

`lxo review <attempt_id>` y el Proof Pack de Desktop muestran partes, revisores,
informes válidos/invalidados, total cubierto, huecos y solapes. `--json` conserva
el objeto coverage completo. Si cambia HEAD, los informes siguen en la historia
pero su cobertura pasa a cero y hay que volver a repartir/revisar.

Aceptar exige cobertura completa, o una decisión explícita de la persona:

```sh
lxo review t1-a1 --accept --accept-uncovered-reason "Revisé personalmente los archivos pendientes"
```

Desktop exige escribir el motivo en la confirmación. El motivo se liga al HEAD
y scope mostrados y no se reutiliza al cambiar esos datos. El RPC attempt_review
recibe coverage_override_reason; la guardia central también protege la revisión
legacy. Mobile envía las revisiones incompletas a Desktop y no puede asumir huecos.
El rechazo no exige completar partes y no elimina informes ni worktree.

Plan e informes se guardan como decisiones durables review_scope y
review_scope_report. Activity solo proyecta metadatos, nunca el resumen. La
aceptación con huecos lleva coverage_override=true en su evento de auditoría;
el motivo queda en el detalle privado de la decisión.

## Validación

Pruebas E2E con Core, SQLite, repositorios/worktrees reales y adapters simulados:
tres revisores/diez archivos; rechazo de identidad/archivos falsos; idempotencia;
huecos/solapes y aceptación explícita; HEAD movido sin reutilizar informes.
Desktop prueba visibilidad, confirmación y rechazo de cobertura incoherente.
No se invocan proveedores externos ni se consumen revisiones de pago.
