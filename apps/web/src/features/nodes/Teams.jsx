import React, { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { LuUsers } from 'react-icons/lu';
import '../../style/Nodes.css';

export default function Teams() {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchTeams = async () => {
    try {
      const res = await api.get('/api/dashboard/init');
      setData(res.data.clients || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTeams();
  }, []);

  if (loading) {
    return <div className="muted teams-loading">Cargando equipos...</div>;
  }

  return (
    <div id="clients" className="section-content active">
      <section className="panel">
        <h2><LuUsers className="teams-title-icon" /> Equipos conectados</h2>
        <p className="muted teams-desc">
          Métricas de uso segregadas por identificador de cliente (`client_id`).
        </p>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Identificador (client_id)</th>
                <th>Conversaciones</th>
                <th>Mensajes</th>
                <th>Tokens totales</th>
                <th>Última actividad</th>
              </tr>
            </thead>
            <tbody>
              {data && data.length > 0 ? (
                data.map((c, idx) => (
                  <tr key={idx}>
                    <td><strong>{c.client_id}</strong></td>
                    <td>{c.conversations}</td>
                    <td>{c.messages}</td>
                    <td><span className="teams-tokens">{c.total_tokens}</span></td>
                    <td className="small muted">{c.last_activity || '-'}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="teams-empty">
                    Aún no hay métricas de equipos.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
