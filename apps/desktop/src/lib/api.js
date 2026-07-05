import { useAppStore } from '../store/appStore';

async function request(endpoint, options = {}) {
  const { serverUrl, apiKey } = useAppStore.getState();
  
  if (!serverUrl) {
    throw new Error('Server URL is not configured. Please check settings.');
  }

  const url = `${serverUrl}${endpoint}`;
  
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const fetchOptions = {
    ...options,
    headers,
    // Timeout real (la opción { timeout } no existe en fetch)
    signal: options.signal || AbortSignal.timeout(options.timeout || 15000),
  };

  if (options.body && typeof options.body === 'object') {
    fetchOptions.body = JSON.stringify(options.body);
  }

  try {
    const response = await fetch(url, fetchOptions);
    
    // Si la respuesta no es exitosa, arrojar error con el detalle del backend
    if (!response.ok) {
      let errorDetail = 'API Request Failed';
      try {
        const errorJson = await response.json();
        errorDetail = errorJson.detail || errorDetail;
      } catch (e) {
        // No es JSON
      }
      throw new Error(errorDetail);
    }

    // Para respuestas vacías/no content
    if (response.status === 204) {
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error(`API Error on ${endpoint}:`, error);
    throw error;
  }
}

export const api = {
  get: (endpoint, options = {}) => request(endpoint, { ...options, method: 'GET' }),
  post: (endpoint, body, options = {}) => request(endpoint, { ...options, method: 'POST', body }),
  put: (endpoint, body, options = {}) => request(endpoint, { ...options, method: 'PUT', body }),
  patch: (endpoint, body, options = {}) => request(endpoint, { ...options, method: 'PATCH', body }),
  delete: (endpoint, options = {}) => request(endpoint, { ...options, method: 'DELETE' }),
};
