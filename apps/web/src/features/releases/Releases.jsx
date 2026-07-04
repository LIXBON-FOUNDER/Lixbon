import React, { useState, useEffect } from 'react';
import { api } from '../../lib/api';
import { LuDownload, LuSparkles, LuCheck, LuCircleHelp, LuInfo } from 'react-icons/lu';
import '../../style/Releases.css';

export default function Releases() {
  const [versions, setVersions] = useState([]);
  const [serverBaseUrl, setServerBaseUrl] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Obtener la URL del backend
    api.get('/api/dashboard/init')
      .then(res => {
        setServerBaseUrl(res.data.server_base_url || window.location.origin);
      })
      .catch(() => {
        setServerBaseUrl(window.location.origin);
      });

    // Obtener las versiones
    api.get('/api/versions')
      .then(res => {
        setVersions(res.data || []);
      })
      .catch(err => {
        console.error('Error cargando versiones:', err);
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, []);

  const getAbsoluteDownloadUrl = (path) => {
    if (!path) return '#';
    if (path.startsWith('http')) return path;
    const base = (serverBaseUrl || window.location.origin).replace(/\/+$/, '');
    return `${base}${path}`;
  };

  return (
    <div id="releases-view" className="section-content active">
      <section className="panel">
        <div className="flex justify-between align-center releases-header">
          <div>
            <h2>
              <LuSparkles className="releases-header-icon" /> 
              Versiones y Descargas de la App
            </h2>
            <p className="muted">
              Historial de lanzamientos de la App Folax Desktop y notas de cambios oficiales.
            </p>
          </div>
        </div>

        {isLoading ? (
          <div className="flex justify-center align-center releases-loading">
            Cargando versiones disponibles...
          </div>
        ) : versions.length === 0 ? (
          <div className="flex flex-col align-center justify-center releases-empty">
            <LuInfo size={32} className="releases-empty-icon" />
            <h3 className="releases-empty-title">No hay versiones registradas aún</h3>
            <p className="muted small releases-empty-desc">
              El pipeline de CI/CD de GitHub Actions registrará y subirá los instaladores automáticamente aquí cuando compiles una versión.
            </p>
          </div>
        ) : (
          <div className="releases-list flex flex-col gap-6">
            {versions.map((v) => {
              const isStable = v.channel === 'stable';
              const downloadLink = getAbsoluteDownloadUrl(v.download_url);
              
              return (
                <div key={v.version} className="release-card">
                  <div className="flex justify-between align-center release-card-header">
                    <div className="flex align-center gap-2">
                      <h3 className="release-version-title">
                        v{v.version}
                      </h3>
                      <span className={`badge release-badge ${isStable ? 'stable' : 'beta'}`}>
                        {v.channel.toUpperCase()}
                      </span>
                    </div>
                    <span className="muted font-mono small">{v.release_date}</span>
                  </div>

                  <h4 className="release-card-title">
                    {v.title}
                  </h4>

                  <ul className="release-changelog">
                    {v.changelog.map((change, idx) => (
                      <li key={idx} className="release-changelog-item">
                        {change}
                      </li>
                    ))}
                  </ul>

                  <div className="flex justify-end">
                    <a 
                      href={downloadLink}
                      download={`app-folax-${v.version}-${v.channel}.msi`}
                      className="button release-download-btn"
                    >
                      <LuDownload /> Descargar Instalador
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
