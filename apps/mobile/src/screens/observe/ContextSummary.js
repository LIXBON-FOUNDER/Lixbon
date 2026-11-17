import React from 'react';
import { View } from 'react-native';

import { Eyebrow, PillButton } from '../../components/ui';
import { ageText } from '../../observe/attention';
import { CONTEXT_NOTES, contextSize, portabilityText } from '../../observe/contextSummary';
import { Body, Mono, Notice, StateText } from '../../observe/ui';
import { useCoreSummary } from '../../observe/useCoreSummary';

export default function ContextSummary({ obs, attemptId }) {
  const summary = useCoreSummary(obs, 'core_attempt_context', { attempt_id: attemptId });
  const data = summary.data;
  const valid = data?.status === 'valid';
  const state = { valid: 'Paquete válido', invalid: 'Paquete inválido', absent: 'Sin paquete guardado' }[data?.status];
  return (
    <View style={{ gap: 10 }}>
      <Eyebrow>ContextPackage</Eyebrow>
      {!summary.supported && <Notice>Actualiza Lixbon en el escritorio para consultar el contexto.</Notice>}
      {summary.loading && !data && <Body muted>Consultando el paquete guardado…</Body>}
      {summary.stale && data && <Notice icon="clock">{`Desactualizado · ${ageText(summary.at, obs.now)}`}</Notice>}
      {data && (
        <>
          <StateText tone={data.status === 'invalid' ? 'warn' : 'muted'}>{state}</StateText>
          <Body>{portabilityText(data)}</Body>
          {valid && (
            <>
              <Mono selectable>{`Origen · ${data.source.task_id} / ${data.source.attempt_id}`}</Mono>
              <Body>{`Proveedor de origen · ${data.source.provider}`}</Body>
              <Body>{`Objetivo · ${data.objective_chars} caracteres`}</Body>
              <Body>{`${data.counts.decisions} decisiones · ${data.counts.files} archivos · ${data.counts.artifacts} artefactos`}</Body>
              <Body>{`${data.counts.redactions} valores ocultos · ${data.counts.truncated_fields} campos recortados`}</Body>
              {data.notes.map((note) => <Notice key={note}>{CONTEXT_NOTES[note]}</Notice>)}
              <Body>{`Paquete · ${contextSize(data.serialized_bytes)} · Adjuntos · ${contextSize(data.counts.attachments_bytes)}`}</Body>
              <Body muted>Checksum del contenido verificado por el Core.</Body>
              <Mono selectable>{data.package_id}</Mono>
              {data.revision ? <Mono selectable>{`Revisión · ${data.revision.base_commit} → ${data.revision.head_commit}`}</Mono> : <Body muted>Sin revisión registrada.</Body>}
              {data.tests ? <Body>{`Pruebas declaradas en el paquete · ${data.tests.passed ?? 'sin dato'} aprobadas · ${data.tests.failed ?? 'sin dato'} fallidas · ${data.tests.ignored ?? 'sin dato'} omitidas`}</Body> : <Body muted>Sin resultados de pruebas en el paquete.</Body>}
              <Body muted>La reanudación nativa usa la sesión del proveedor, cuya disponibilidad aparece en Capacidades.</Body>
            </>
          )}
        </>
      )}
      {summary.error && <Notice>No se pudo verificar el estado actual del paquete.</Notice>}
      {summary.supported && <PillButton outline label="Actualizar contexto" disabled={!summary.online || summary.loading} style={{ minHeight: 48 }} onPress={summary.refresh} />}
    </View>
  );
}
