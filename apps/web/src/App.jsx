import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './features/auth/AuthContext';
import { ProtectedRoute } from './features/auth/ProtectedRoute';
import { MainLayout } from './layouts/MainLayout';

// Features (Pages)
import Login from './features/auth/Login';
import Register from './features/auth/Register';
import Dashboard from './features/dashboard/Dashboard';
import Nodes from './features/nodes/Nodes';
import Teams from './features/nodes/Teams';
import Chat from './features/chat/Chat';
import Keys from './features/keys/Keys';
import Delegation from './features/delegation/Delegation';
import Integrations from './features/integrations/Integrations';
import Installer from './features/installer/Installer';
import Releases from './features/releases/Releases';

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          
          <Route element={<ProtectedRoute><MainLayout /></ProtectedRoute>}>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/nodes" element={<Nodes />} />
            <Route path="/chat" element={<Chat />} />
            <Route path="/keys" element={<Keys />} />
            <Route path="/delegation" element={<Delegation />} />
            <Route path="/teams" element={<Teams />} />
            <Route path="/integrations" element={<Integrations />} />
            <Route path="/installer" element={<Installer />} />
            <Route path="/releases" element={<Releases />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
