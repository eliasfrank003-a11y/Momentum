import React, { useState, useEffect, useMemo } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { Calendar, RefreshCw, ArrowUpRight, ArrowDownRight, Smartphone, Settings } from 'lucide-react';
import { CSV_DATA } from './data/initialData';

// --- CONFIG ---
// Use this exact name to find the calendar
const TARGET_CALENDAR_NAME = "ATracker"; 
const GOOGLE_CLIENT_ID = "YOUR_GOOGLE_CLIENT_ID_HERE"; // You will need to add this
const GOOGLE_API_KEY = "YOUR_GOOGLE_API_KEY_HERE";     // You will need to add this
const DISCOVERY_DOCS = ["https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest"];
const SCOPES = "https://www.googleapis.com/auth/calendar.readonly";

const TABS = ['1D', '7D', '30D', '1Y', 'MAX'];

// --- HELPERS ---
const formatDuration = (seconds) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  if (h === 0) return `${m}m ${s}s`;
  return `${h}h ${m}m ${s}s`;
};

const formatDate = (dateStr) => {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

export default function App() {
  const [activeTab, setActiveTab] = useState('7D');
  const [sessions, setSessions] = useState([]);
  const [isSyncing, setIsSyncing] = useState(false);
  const [gapiLoaded, setGapiLoaded] = useState(false);
  const [user, setUser] = useState(null);

  // 1. Initialize Data from CSV
  useEffect(() => {
    // Process CSV Data into standardized objects
    const initial = CSV_DATA.map(d => ({
      id: d.start, // use start time as ID
      start: new Date(d.start),
      duration: d.duration, // in seconds
      source: 'csv'
    }));
    setSessions(initial);
  }, []);

  // 2. Google Auth Setup
  useEffect(() => {
    const initClient = () => {
      window.gapi.client.init({
        apiKey: GOOGLE_API_KEY,
        clientId: GOOGLE_CLIENT_ID,
        discoveryDocs: DISCOVERY_DOCS,
        scope: SCOPES,
      }).then(() => {
        setGapiLoaded(true);
        const authInstance = window.gapi.auth2.getAuthInstance();
        setUser(authInstance.isSignedIn.get() ? authInstance.currentUser.get() : null);
        authInstance.isSignedIn.listen(isSignedIn => {
          setUser(isSignedIn ? authInstance.currentUser.get() : null);
        });
      });
    };
    if (window.gapi) window.gapi.load('client:auth2', initClient);
  }, []);

  const handleSync = async () => {
    if (!gapiLoaded) return;
    if (!user) {
      window.gapi.auth2.getAuthInstance().signIn();
      return;
    }

    setIsSyncing(true);
    try {
      // Find Calendar ID
      const calList = await window.gapi.client.calendar.calendarList.list();
      const targetCal = calList.result.items.find(c => 
        c.summary.toLowerCase() === TARGET_CALENDAR_NAME.toLowerCase()
      );

      if (!targetCal) {
        alert(`Calendar "${TARGET_CALENDAR_NAME}" not found.`);
        setIsSyncing(false);
        return;
      }

      // Fetch Events since last CSV entry (approx Jan 17 2026)
      // For safety, let's just fetch from Jan 1 2026 to catch overlap/new
      const events = await window.gapi.client.calendar.events.list({
        calendarId: targetCal.id,
        timeMin: new Date("2026-01-17T00:00:00Z").toISOString(),
        showDeleted: false,
        singleEvents: true,
        orderBy: 'startTime'
      });

      const newSessions = events.result.items.map(e => {
        if (!e.start.dateTime || !e.end.dateTime) return null;
        const start = new Date(e.start.dateTime);
        const end = new Date(e.end.dateTime);
        const duration = (end - start) / 1000; // seconds
        return {
          id: e.id,
          start: start,
          duration: duration,
          source: 'google'
        };
      }).filter(Boolean);

      // Merge avoiding duplicates (simple ID check won't work perfectly between CSV/Google, 
      // but assuming dates don't overlap perfectly down to second for manual vs csv)
      setSessions(prev => {
        const existingIds = new Set(prev.map(p => p.start.getTime())); // use timestamp as unique key
        const uniqueNew = newSessions.filter(n => !existingIds.has(n.start.getTime()));
        return [...prev, ...uniqueNew].sort((a, b) => a.start - b.start);
      });

    } catch (error) {
      console.error("Sync Error", error);
      alert("Failed to sync. Check console.");
    } finally {
      setIsSyncing(false);
    }
  };

  // 3. Process Data for Chart (The "Stock" Logic)
  const chartData = useMemo(() => {
    if (sessions.length === 0) return [];

    // Sort by date
    const sorted = [...sessions].sort((a, b) => a.start - b.start);
    const startDate = sorted[0].start; // Dec 17, 2025
    
    // Create a map of "Day String" -> "Total Seconds Played That Day"
    const dailyTotals = {};
    const lastDayStr = new Date().toISOString().split('T')[0];
    
    // Fill all days from start to today with 0 initially (to handle rest days)
    const dayMap = new Map();
    let curr = new Date(startDate);
    curr.setHours(0,0,0,0);
    const today = new Date();
    today.setHours(0,0,0,0);

    while (curr <= today) {
      dayMap.set(curr.toISOString().split('T')[0], 0);
      curr.setDate(curr.getDate() + 1);
    }

    // Populate play time
    sorted.forEach(s => {
      const dStr = s.start.toISOString().split('T')[0];
      if (dayMap.has(dStr)) {
        dayMap.set(dStr, dayMap.get(dStr) + s.duration);
      }
    });

    // Calculate Cumulative Average
    let cumulativeSeconds = 0;
    let daysElapsed = 0;
    const dataPoints = [];

    for (const [dateStr, dailySeconds] of dayMap) {
      daysElapsed++; // Day 1, Day 2, etc.
      cumulativeSeconds += dailySeconds;
      
      const averageSoFar = cumulativeSeconds / daysElapsed;
      
      dataPoints.push({
        date: dateStr,
        average: averageSoFar,
        dailyPlay: dailySeconds, // Store for tooltip
        formattedDate: formatDate(dateStr)
      });
    }

    return dataPoints;
  }, [sessions]);

  // 4. Filter by Tab
  const filteredData = useMemo(() => {
    if (chartData.length === 0) return [];
    const now = new Date();
    let daysToSubtract = 0;
    if (activeTab === '1D') daysToSubtract = 1; // Special case handled in UI?
    if (activeTab === '7D') daysToSubtract = 7;
    if (activeTab === '30D') daysToSubtract = 30;
    if (activeTab === '1Y') daysToSubtract = 365;
    if (activeTab === 'MAX') return chartData;

    const cutoff = new Date();
    cutoff.setDate(now.getDate() - daysToSubtract);
    const cutoffStr = cutoff.toISOString().split('T')[0];
    
    return chartData.filter(d => d.date >= cutoffStr);
  }, [chartData, activeTab]);

  // 5. Determine Trend
  const startPrice = filteredData.length > 0 ? filteredData[0].average : 0;
  const currentPrice = filteredData.length > 0 ? filteredData[filteredData.length - 1].average : 0;
  const isProfit = currentPrice >= startPrice;
  const color = isProfit ? '#22c55e' : '#ef4444'; // Tailwind green-500 / red-500

  // Interaction State
  const [hoverData, setHoverData] = useState(null);
  const displayPrice = hoverData ? hoverData.average : currentPrice;
  const displayDate = hoverData ? hoverData.formattedDate : "Today";

  return (
    <div className="flex flex-col h-[100dvh] bg-black text-white font-sans overflow-hidden">
      
      {/* HEADER */}
      <div className="p-6 pt-12 flex justify-between items-start">
        <div>
          <div className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-1">{displayDate}</div>
          <div className={`text-4xl font-bold tracking-tight flex items-baseline gap-2 transition-colors duration-300 ${hoverData ? 'text-white' : (isProfit ? 'text-green-500' : 'text-red-500')}`}>
             {formatDuration(displayPrice)}
             <span className="text-sm font-medium text-gray-500">avg/day</span>
          </div>
          {/* Delta Pill */}
          {!hoverData && (
            <div className={`mt-2 inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-bold bg-white/10 ${isProfit ? 'text-green-400' : 'text-red-400'}`}>
               {isProfit ? <ArrowUpRight size={12}/> : <ArrowDownRight size={12}/>}
               {Math.abs(currentPrice - startPrice).toFixed(0)}s {activeTab}
            </div>
          )}
        </div>

        <button 
          onClick={handleSync} 
          disabled={isSyncing}
          className="p-3 bg-gray-900 rounded-full text-gray-400 hover:text-white hover:bg-gray-800 transition-all active:scale-95"
        >
          {isSyncing ? <RefreshCw className="animate-spin" size={20}/> : <Calendar size={20}/>}
        </button>
      </div>

      {/* CHART AREA */}
      <div className="flex-1 w-full relative">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={filteredData} onMouseMove={(e) => { if(e.activePayload) setHoverData(e.activePayload[0].payload) }} onMouseLeave={() => setHoverData(null)}>
            <defs>
              <linearGradient id="colorGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={color} stopOpacity={0.3}/>
                <stop offset="95%" stopColor={color} stopOpacity={0}/>
              </linearGradient>
            </defs>
            <Tooltip 
               content={({ active, payload }) => {
                 if (active && payload && payload.length) {
                   return (
                     <div className="bg-gray-900 border border-gray-800 p-3 rounded-xl shadow-2xl">
                       <p className="text-gray-400 text-xs font-bold mb-1">{payload[0].payload.formattedDate}</p>
                       <p className="text-white font-mono font-bold">{formatDuration(payload[0].value)} avg</p>
                       <div className="mt-2 pt-2 border-t border-gray-800 flex justify-between gap-4">
                          <span className="text-xs text-gray-500">Played:</span>
                          <span className="text-xs font-bold text-gray-300">{formatDuration(payload[0].payload.dailyPlay)}</span>
                       </div>
                     </div>
                   );
                 }
                 return null;
               }}
            />
            {/* Dashed Reference Line (Opening Price) */}
            <ReferenceLine y={startPrice} stroke="gray" strokeDasharray="3 3" strokeOpacity={0.3} />
            
            <Area 
              type="monotone" 
              dataKey="average" 
              stroke={color} 
              strokeWidth={3}
              fill="url(#colorGradient)" 
              animationDuration={1500}
              isAnimationActive={true}
              baseLine={startPrice} // This makes the fill gradient start from the reference line technically, but typically 0
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* TABS */}
      <div className="p-6 pb-12 safe-area-pb">
        <div className="flex bg-gray-900/50 p-1 rounded-2xl backdrop-blur-md">
          {TABS.map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 py-3 text-sm font-bold rounded-xl transition-all duration-200 ${activeTab === tab ? 'bg-gray-800 text-white shadow-lg' : 'text-gray-500 hover:text-gray-300'}`}
            >
              {tab}
            </button>
          ))}
        </div>
        
        {/* Helper Note for Install */}
        <div className="mt-8 text-center">
            <p className="text-[10px] text-gray-700 font-bold uppercase tracking-widest flex items-center justify-center gap-2">
               <Smartphone size={12}/> Add to Home Screen for Full Experience
            </p>
        </div>
      </div>
    </div>
  );
}
