import React, { useState } from 'react';
import { LuDownload, LuX, LuInfo } from 'react-icons/lu';

export function UpdateBanner({ updateInfo, onInstall, isDownloading, downloadProgress }) {
  const [dismissed, setDismissed] = useState(false);
  const [showModal, setShowModal] = useState(false);

  if (dismissed || !updateInfo) return null;

  return (
    <>
      <div className="update-banner flex align-center justify-between">
        <div className="flex align-center gap-2">
          <LuInfo size={16} className="info-icon" />
          <span>
            Actualización disponible: <strong>v{updateInfo.latest_version}</strong> ({updateInfo.channel}) — {updateInfo.title}
          </span>
        </div>
        
        <div className="flex align-center gap-2">
          <button onClick={() => setShowModal(true)} className="btn-notes">
            Ver cambios
          </button>
          
          <button 
            onClick={onInstall} 
            disabled={isDownloading}
            className="btn-update flex align-center gap-1"
          >
            <LuDownload size={14} />
            <span>{isDownloading ? `Descargando... ${downloadProgress}%` : 'Actualizar'}</span>
          </button>

          <button onClick={() => setDismissed(true)} className="close-btn">
            <LuX size={16} />
          </button>
        </div>

        <style dangerouslySetInnerHTML={{ __html: `
          .update-banner {
            background: linear-gradient(90deg, rgba(124, 58, 237, 0.2) 0%, rgba(59, 130, 246, 0.2) 100%);
            border-bottom: 1px solid var(--accent);
            padding: 8px 24px;
            font-size: 0.85rem;
            color: #ffffff;
            animation: slideDown 0.3s ease-out;
          }
          .light-theme .update-banner {
            color: var(--text-primary);
          }
          .info-icon {
            color: var(--accent);
          }
          .btn-notes {
            font-size: 0.75rem;
            color: var(--text-secondary);
            cursor: pointer;
            text-decoration: underline;
            padding: 4px 8px;
          }
          .btn-notes:hover {
            color: #fff;
          }
          .light-theme .btn-notes:hover {
            color: var(--text-primary);
          }
          .btn-update {
            background-color: var(--accent);
            color: white;
            font-size: 0.75rem;
            font-weight: 600;
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
            transition: opacity 0.2s;
          }
          .btn-update:hover {
            opacity: 0.9;
          }
          .btn-update:disabled {
            background-color: var(--border);
            color: var(--text-muted);
            cursor: not-allowed;
          }
          .close-btn {
            color: var(--text-secondary);
            cursor: pointer;
            padding: 4px;
            display: flex;
            align-items: center;
          }
          .close-btn:hover {
            color: #fff;
          }

          @keyframes slideDown {
            from { transform: translateY(-100%); }
            to { transform: translateY(0); }
          }
        `}} />
      </div>

      {/* Modal de Notas de Cambios */}
      {showModal && (
        <div className="notes-modal-overlay flex align-center justify-center">
          <div className="notes-modal flex flex-col gap-4">
            <div className="modal-header flex align-center justify-between">
              <h2>Cambios en v{updateInfo.latest_version}</h2>
              <button onClick={() => setShowModal(false)} className="close-modal-btn">
                <LuX size={20} />
              </button>
            </div>
            
            <div className="modal-body">
              <h3 style={{ color: '#fff', marginBottom: '12px' }}>{updateInfo.title}</h3>
              <p style={{ color: 'var(--text-secondary)', marginBottom: '16px', fontSize: '0.85rem' }}>
                Fecha de lanzamiento: {updateInfo.release_date}
              </p>
              
              <ul className="changelog-list">
                {updateInfo.changelog && updateInfo.changelog.map((item, index) => (
                  <li key={index} style={{ marginBottom: '8px', fontSize: '0.9rem', lineHeight: '1.4' }}>
                    {item}
                  </li>
                ))}
              </ul>
            </div>

            <div className="modal-footer flex justify-between align-center">
              <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                SHA256: {updateInfo.checksum_sha256 ? `${updateInfo.checksum_sha256.slice(0, 16)}...` : 'N/A'}
              </span>
              <button 
                onClick={() => {
                  setShowModal(false);
                  onInstall();
                }}
                disabled={isDownloading}
                className="btn-update flex align-center gap-1"
                style={{ padding: '8px 16px', fontSize: '0.85rem' }}
              >
                <LuDownload size={14} />
                <span>{isDownloading ? 'Descargando...' : 'Descargar e Instalar'}</span>
              </button>
            </div>
          </div>

          <style dangerouslySetInnerHTML={{ __html: `
            .notes-modal-overlay {
              position: fixed;
              top: 0;
              left: 0;
              width: 100vw;
              height: 100vh;
              background-color: rgba(5, 5, 5, 0.8);
              z-index: 10000;
              backdrop-filter: blur(4px);
            }
            .notes-modal {
              background-color: var(--bg-secondary);
              border: 1px solid var(--border);
              border-radius: 12px;
              width: 90%;
              max-width: 500px;
              padding: 24px;
              box-shadow: 0 10px 30px rgba(0,0,0,0.5);
            }
            .modal-header h2 {
              font-size: 1.25rem;
              font-weight: 700;
              color: #fff;
            }
            .close-modal-btn {
              color: var(--text-secondary);
              cursor: pointer;
            }
            .close-modal-btn:hover {
              color: #fff;
            }
            .changelog-list {
              padding-left: 20px;
            }
          `}} />
        </div>
      )}
    </>
  );
}
