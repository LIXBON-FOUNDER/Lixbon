import { api } from './api';

export const listSkills = () => api.get('/api/skills').then((r) => r.data.skills);
export const getSkill = (slug) => api.get(`/api/skills/${slug}`).then((r) => r.data);
export const rateSkill = (slug, stars) => (stars
  ? api.put(`/api/skills/${slug}/rating`, { stars })
  : api.delete(`/api/skills/${slug}/rating`)).then((r) => r.data);

export async function downloadSkill(slug, version) {
  const r = await api.get(`/api/skills/${slug}/download`, {
    params: { client: 'web', ...(version ? { version } : {}) }, responseType: 'blob',
  });
  const url = URL.createObjectURL(r.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slug}-${r.headers['x-skill-version']}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return r.headers['x-skill-version'];
}

export const adminListSkills = () => api.get('/api/admin/skills').then((r) => r.data.skills);
export const adminGetSkill = (slug) => api.get(`/api/admin/skills/${slug}`).then((r) => r.data);
export const adminUpdateSkill = (slug, patch) => api.patch(`/api/admin/skills/${slug}`, patch).then((r) => r.data);
export const adminDeleteSkill = (slug) => api.delete(`/api/admin/skills/${slug}`);

const aBase64 = (file) => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
  fr.onerror = reject;
  fr.readAsDataURL(file);
});

// `files` viene de un <input webkitdirectory>: cada File trae su ruta relativa.
export async function adminPublishVersion(files, version, changelog) {
  const payload = await Promise.all([...files].map(async (f) => ({
    path: f.webkitRelativePath || f.name, base64: await aBase64(f),
  })));
  return api.post('/api/admin/skills/versions', { version, changelog, files: payload }).then((r) => r.data);
}

export const fmtPeso = (bytes) => (bytes >= 1024 * 1024
  ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
