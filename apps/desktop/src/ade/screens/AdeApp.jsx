// AdeApp.jsx — raíz del ADE: cliente + host + router + shell + pantalla activa.
//
// Es lo único que el Desktop tendrá que montar cuando se integre (un modo nuevo o un panel):
//   <AdeApp client={coreAdeClient} host={shellHost} ideContext={{ worktreePath }} />
// Nada aquí conoce el origen de los datos.
import { AdeProvider } from '../state/AdeProvider';
import { NavProvider, useAdeRouter, useNav } from '../navigation/useAdeRouter';
import { AppShell } from '../layouts/AppShell';
import { HomeScreen } from './home/HomeScreen';
import { ProjectsScreen } from './ProjectsScreen';
import { ProjectScreen } from './detail/ProjectScreen';
import { TaskScreen } from './detail/TaskScreen';
import { AttemptScreen } from './detail/AttemptScreen';
import { ThreadScreen } from './detail/ThreadScreen';
import { ReviewScreen } from './detail/ReviewScreen';
import { IntegrationScreen } from './detail/IntegrationScreen';
import { ActivityScreen } from './ActivityScreen';
import { AgentsScreen } from './AgentsScreen';
import { SettingsScreen } from './SettingsScreen';
import { IdeContextPanel } from './IdeContextPanel';
import '../styles';

export function RouteView() {
  const { route } = useNav();
  switch (route.screen) {
    case 'projects': return <ProjectsScreen />;
    case 'project': return <ProjectScreen projectId={route.projectId} />;
    case 'task': return <TaskScreen taskId={route.taskId} />;
    case 'attempt': return <AttemptScreen attemptId={route.attemptId} />;
    case 'thread': return <ThreadScreen threadId={route.threadId} />;
    case 'review': return <ReviewScreen attemptId={route.attemptId} />;
    case 'integration': return <IntegrationScreen attemptId={route.attemptId} />;
    case 'activity': return <ActivityScreen />;
    case 'agents': return <AgentsScreen />;
    case 'settings': return <SettingsScreen />;
    default: return <HomeScreen />;
  }
}

/**
 * @param {{client: object, host?: object, now?: () => number, mode?: 'wide'|'narrow'|'mobile', initialRoute?: object,
 *          syncHash?: boolean, ideContext?: {path?: string, worktreePath?: string, branch?: string}, title?: string}} props
 */
export function AdeApp({ client, host, now, mode, initialRoute, syncHash = false, ideContext, title }) {
  const router = useAdeRouter({ initial: initialRoute, syncHash });
  return (
    <AdeProvider client={client} host={host} now={now}>
      <NavProvider value={router}>
        <AppShell mode={mode} title={title}>
          {ideContext && <IdeContextPanel locator={ideContext} />}
          <RouteView />
        </AppShell>
      </NavProvider>
    </AdeProvider>
  );
}
