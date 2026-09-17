// index.js — junta los diccionarios de cada namespace para useT().
import common from './common';
import nav from './nav';
import sidebar from './sidebar';
import landing from './landing';
import auth from './auth';
import chat from './chat';
import account from './account';
import plans from './plans';
import visuals from './visuals';
import downloads from './downloads';
import releases from './releases';
import status from './status';
import docsShell from './docsShell';
import guiasShell from './guiasShell';
import legalShell from './legalShell';
import shared from './shared';
import remote from './remote';
import notFound from './notFound';
import dialogs from './dialogs';
import illustrations from './illustrations';

export const DICTIONARIES = {
  illustrations,
  common,
  nav,
  sidebar,
  landing,
  auth,
  chat,
  account,
  plans,
  visuals,
  downloads,
  releases,
  status,
  docsShell,
  guiasShell,
  legalShell,
  shared,
  remote,
  notFound,
  dialogs,
};
