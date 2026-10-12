// index.js — API pública del ADE. Lo que el Desktop (o un panel junto al IDE) importará cuando se integre.
export { AdeApp } from './screens/AdeApp';
export { IdeContextPanel } from './screens/IdeContextPanel';
export { createMockAdeClient } from './client/MockAdeClient';
export { createCoreAdeClient } from './client/CoreAdeClient';
export { createNullHost } from './host/AdeHost';
export { assertAdeClient, ADE_METHODS } from './client/contract';
