import React from 'react';
import { 
  ResponsiveContainer, 
  AreaChart, 
  Area, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  Legend 
} from 'recharts';
import { useAppStore } from '../../store/appStore';

export function UsageChart({ data }) {
  const { accentColor } = useAppStore();

  if (!data || data.length === 0) {
    return (
      <div className="empty-chart flex align-center justify-center font-mono">
        [NO METRIC DATA FOUND FOR CHART]
      </div>
    );
  }

  return (
    <div className="usage-chart-container">
      <ResponsiveContainer width="100%" height={320}>
        <AreaChart data={data} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
          <defs>
            <linearGradient id="colorPrompt" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--accent-alt)" stopOpacity={0.4}/>
              <stop offset="95%" stopColor="var(--accent-alt)" stopOpacity={0}/>
            </linearGradient>
            <linearGradient id="colorCompletion" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={accentColor} stopOpacity={0.4}/>
              <stop offset="95%" stopColor={accentColor} stopOpacity={0}/>
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.5} />
          <XAxis 
            dataKey="date" 
            stroke="var(--text-secondary)" 
            fontSize={11}
            tickLine={false}
            fontFamily="var(--font-mono)"
          />
          <YAxis 
            stroke="var(--text-secondary)" 
            fontSize={11}
            tickLine={false}
            fontFamily="var(--font-mono)"
          />
          <Tooltip 
            contentStyle={{ 
              backgroundColor: 'var(--bg-secondary)', 
              borderColor: 'var(--border)',
              borderRadius: '8px',
              color: 'var(--text-primary)',
              fontSize: '12px',
              fontFamily: 'var(--font-mono)'
            }}
          />
          <Legend 
            verticalAlign="top" 
            height={36} 
            iconType="circle"
            fontSize={12}
            wrapperStyle={{ fontSize: '12px' }}
          />
          <Area 
            name="Prompt Tokens"
            type="monotone" 
            dataKey="prompt_tokens" 
            stroke="var(--accent-alt)" 
            fillOpacity={1} 
            fill="url(#colorPrompt)" 
          />
          <Area 
            name="Completion Tokens"
            type="monotone" 
            dataKey="completion_tokens" 
            stroke={accentColor} 
            fillOpacity={1} 
            fill="url(#colorCompletion)" 
          />
        </AreaChart>
      </ResponsiveContainer>

      <style dangerouslySetInnerHTML={{ __html: `
        .usage-chart-container {
          background-color: var(--bg-secondary);
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 20px;
          margin-bottom: 24px;
        }
        .empty-chart {
          height: 320px;
          background-color: var(--bg-secondary);
          border: 1px solid var(--border);
          border-radius: 8px;
          color: var(--text-muted);
        }
      `}} />
    </div>
  );
}
