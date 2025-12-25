import React, { useState, useRef, useEffect, useCallback, useMemo, useReducer } from 'react';
import { 
  Image as ImageIcon, 
  Trash2, 
  ChevronLeft, 
  ChevronRight,
  Upload, 
  Folder,
  Plus,
  X,
  FolderPlus,
  FolderUp,
  Loader2,
  CheckCircle2,
  AlertCircle,
  WifiOff
} from 'lucide-react';

// --- API CONFIGURATION ---
const BASE_URL = 'https://694d4185ad0f8c8e6e203206.mockapi.io/vault';
const RESOURCE_ID = '1'; // We'll use a single document to store the nested structure for simplicity

// --- STATE MANAGEMENT ---
const initialState = {
  items: [],
  status: 'loading', 
  syncing: false,
  error: null
};

function albumReducer(state, action) {
  switch (action.type) {
    case 'FETCH_START':
      return { ...state, status: 'loading', error: null };
    case 'FETCH_SUCCESS':
      return { ...state, status: 'succeeded', items: action.payload, error: null };
    case 'FETCH_ERROR':
      return { ...state, status: 'failed', error: action.payload };
    case 'SYNC_START':
      return { ...state, syncing: true };
    case 'SYNC_END':
      return { ...state, syncing: false };
    case 'SET_ITEMS':
      return { ...state, items: action.payload };
    default:
      return state;
  }
}

const App = () => {
  const [state, dispatch] = useReducer(albumReducer, initialState);
  const { items: albums, status, syncing, error } = state;
  
  const [currentPath, setCurrentPath] = useState([]); 
  const [isCreatingAlbum, setIsCreatingAlbum] = useState(false);
  const [newAlbumName, setNewAlbumName] = useState('');
  const [viewerIndex, setViewerIndex] = useState(null); 
  
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);

  // --- API OPERATIONS ---
  const loadData = async () => {
    dispatch({ type: 'FETCH_START' });
    try {
      const response = await fetch(`${BASE_URL}/${RESOURCE_ID}`);
      if (!response.ok) {
        // If 404, the resource might not exist yet, initialize it
        if (response.status === 404) {
          await fetch(BASE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: RESOURCE_ID, data: [] })
          });
          dispatch({ type: 'FETCH_SUCCESS', payload: [] });
          return;
        }
        throw new Error('Failed to fetch from MockAPI');
      }
      const result = await response.json();
      dispatch({ type: 'FETCH_SUCCESS', payload: result.data || [] });
    } catch (err) {
      dispatch({ type: 'FETCH_ERROR', payload: err.message });
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const persistToMockAPI = async (newAlbums) => {
    dispatch({ type: 'SYNC_START' });
    try {
      const response = await fetch(`${BASE_URL}/${RESOURCE_ID}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: newAlbums })
      });
      if (!response.ok) throw new Error('Sync failed');
    } catch (err) {
      console.error("API Sync Error:", err);
    } finally {
      dispatch({ type: 'SYNC_END' });
    }
  };

  const updateAndPersist = async (newAlbums) => {
    dispatch({ type: 'SET_ITEMS', payload: newAlbums });
    await persistToMockAPI(newAlbums);
  };

  // --- LOGIC ---
  const getPlaceholderUrl = (seed) => {
    return `https://picsum.photos/seed/${seed}/800/600`;
  };

  const getCurrentDirectory = useCallback(() => {
    let current = albums;
    for (const id of currentPath) {
      const folder = current.find(a => a.id === id);
      if (folder) current = folder.subAlbums || [];
    }
    return current;
  }, [albums, currentPath]);

  const getCurrentAlbum = useCallback(() => {
    if (currentPath.length === 0) return null;
    let current = null;
    let list = albums;
    for (const id of currentPath) {
      current = list.find(a => a.id === id);
      list = current?.subAlbums || [];
    }
    return current;
  }, [albums, currentPath]);

  const activePhotos = useMemo(() => {
    const album = getCurrentAlbum();
    return album ? (album.images || []) : [];
  }, [getCurrentAlbum]);

  const handleFileUpload = async (e) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    if (!files.length || currentPath.length === 0) return;

    const newImages = files.map(file => ({
      id: Math.random().toString(36).substr(2, 9),
      name: file.name,
      url: getPlaceholderUrl(encodeURIComponent(file.name + Math.random())), 
      size: (file.size / 1024).toFixed(1) + ' KB',
      timestamp: Date.now()
    }));

    const updateRecursive = (list) => {
      return list.map(item => {
        if (item.id === currentPath[currentPath.length - 1]) {
          return { ...item, images: [...(item.images || []), ...newImages] };
        }
        if (item.subAlbums) {
          return { ...item, subAlbums: updateRecursive(item.subAlbums) };
        }
        return item;
      });
    };
    
    await updateAndPersist(updateRecursive(albums));
    e.target.value = '';
  };

  const createAlbum = async () => {
    if (!newAlbumName.trim()) return;
    const newAlbum = {
      id: Math.random().toString(36).substr(2, 9),
      name: newAlbumName,
      images: [],
      subAlbums: []
    };

    let nextAlbums;
    if (currentPath.length === 0) {
      nextAlbums = [...albums, newAlbum];
    } else {
      const updateRecursive = (list) => {
        return list.map(item => {
          if (item.id === currentPath[currentPath.length - 1]) {
            return { ...item, subAlbums: [...(item.subAlbums || []), newAlbum] };
          }
          if (item.subAlbums) {
            return { ...item, subAlbums: updateRecursive(item.subAlbums) };
          }
          return item;
        });
      };
      nextAlbums = updateRecursive(albums);
    }
    
    await updateAndPersist(nextAlbums);
    setNewAlbumName('');
    setIsCreatingAlbum(false);
  };

  const deleteAlbum = async (e, id) => {
    e.stopPropagation();
    const deleteRecursive = (list) => {
      return list.filter(item => {
        if (item.id === id) return false;
        if (item.subAlbums) {
          item.subAlbums = deleteRecursive(item.subAlbums);
        }
        return true;
      });
    };
    await updateAndPersist(deleteRecursive([...albums]));
  };

  const deleteImage = async (e, imageId) => {
    e.stopPropagation();
    const deleteFromRecursive = (list) => {
      return list.map(item => {
        const newItem = { ...item };
        if (newItem.images) newItem.images = newItem.images.filter(img => img.id !== imageId);
        if (newItem.subAlbums) newItem.subAlbums = deleteFromRecursive(newItem.subAlbums);
        return newItem;
      });
    };
    await updateAndPersist(deleteFromRecursive([...albums]));
  };

  if (status === 'loading') {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center bg-white z-[100]">
        <Loader2 className="w-10 h-10 text-indigo-600 animate-spin mb-4" />
        <p className="text-xs font-black text-slate-400 uppercase tracking-widest text-center">
          Connecting to MockAPI...
        </p>
      </div>
    );
  }

  if (status === 'failed') {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center bg-white z-[100] px-6">
        <WifiOff className="w-12 h-12 text-red-400 mb-4" />
        <h2 className="text-lg font-black text-slate-800 mb-2">Sync Error</h2>
        <p className="text-slate-500 text-sm mb-6 text-center max-w-xs">{error}</p>
        <button onClick={loadData} className="px-6 py-2 bg-indigo-600 text-white rounded-xl font-bold shadow-lg">Retry Connection</button>
      </div>
    );
  }

  const currentItems = getCurrentDirectory();
  const currentAlbum = getCurrentAlbum();

  return (
    <div className="flex flex-col h-screen bg-slate-50 text-slate-900 font-sans overflow-hidden">
      {/* Sync Status Overlay */}
      <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2 bg-white rounded-full shadow-lg border text-[10px] font-black uppercase tracking-widest">
        {syncing ? (
          <>
            <Loader2 size={12} className="text-indigo-600 animate-spin" /> 
            <span className="text-indigo-600">Syncing to MockAPI...</span>
          </>
        ) : (
          <>
            <CheckCircle2 size={12} className="text-green-500" /> 
            <span className="text-slate-500">MockAPI Live</span>
          </>
        )}
      </div>

      <header className="bg-white border-b flex-shrink-0 z-20 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3 cursor-pointer" onClick={() => setCurrentPath([])}>
            <div className="bg-indigo-600 p-2 rounded-xl shadow-lg">
              <ImageIcon className="text-white w-5 h-5" />
            </div>
            <h1 className="text-xl font-black tracking-tight text-slate-800">FireVault</h1>
          </div>
          <div className="flex items-center gap-2">
            <button 
              onClick={() => folderInputRef.current?.click()} 
              className="bg-white border px-4 py-2 rounded-full text-xs font-bold transition-all flex items-center gap-2 hover:bg-slate-50 active:scale-95"
            >
              <FolderUp size={14} /> <span className="hidden sm:inline">Import Folder</span>
            </button>
            {currentPath.length > 0 && (
              <button 
                onClick={() => fileInputRef.current?.click()} 
                className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-full text-xs font-bold shadow-md flex items-center gap-2 transition-all active:scale-95"
              >
                <Upload size={14} /> <span>Upload</span>
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-7xl mx-auto px-4 py-8">
          {/* Breadcrumbs */}
          <div className="mb-6 flex items-center gap-2 text-[10px] text-slate-400 font-black tracking-widest uppercase bg-white border px-4 py-2.5 rounded-xl shadow-sm overflow-x-auto whitespace-nowrap">
            <span className="hover:text-indigo-600 cursor-pointer transition-colors" onClick={() => setCurrentPath([])}>Root</span>
            {currentPath.map((id, index) => (
              <React.Fragment key={id}>
                <ChevronRight size={12} className="flex-shrink-0" />
                <span 
                  className="text-indigo-600 truncate max-w-[120px] cursor-pointer"
                  onClick={() => setCurrentPath(currentPath.slice(0, index + 1))}
                >
                  {id}
                </span>
              </React.Fragment>
            ))}
          </div>

          <div className="mb-8 flex items-center justify-between">
            <div className="flex items-center gap-4">
              {currentPath.length > 0 && (
                <button 
                  onClick={() => setCurrentPath(prev => prev.slice(0, -1))} 
                  className="p-2.5 bg-white border rounded-xl hover:bg-slate-50 shadow-sm transition-all active:scale-90"
                >
                  <ChevronLeft size={18} />
                </button>
              )}
              <h2 className="text-2xl font-black text-slate-800 truncate max-w-[200px] sm:max-w-md">
                {currentPath.length === 0 ? "Cloud Library" : currentAlbum?.name}
              </h2>
            </div>
            <button 
              onClick={() => setIsCreatingAlbum(true)} 
              className="bg-white border-2 border-slate-100 text-slate-700 hover:border-indigo-500 hover:text-indigo-600 px-5 py-2 rounded-xl font-bold transition-all text-xs flex items-center gap-2 shadow-sm active:scale-95"
            >
              <FolderPlus size={16} /> New Folder
            </button>
          </div>

          {/* Grid Layout */}
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5">
            {isCreatingAlbum && (
              <div className="bg-white p-4 rounded-xl border-2 border-dashed border-indigo-300 flex flex-col gap-3 shadow-lg animate-in zoom-in-95">
                <input 
                  autoFocus 
                  className="w-full px-3 py-2 border rounded-lg text-xs font-bold outline-none border-indigo-100 focus:border-indigo-500 transition-colors" 
                  placeholder="Folder Name..." 
                  value={newAlbumName} 
                  onChange={(e) => setNewAlbumName(e.target.value)} 
                  onKeyDown={(e) => e.key === 'Enter' && createAlbum()} 
                />
                <div className="flex gap-2">
                  <button onClick={createAlbum} className="flex-1 bg-indigo-600 text-white py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider">Create</button>
                  <button onClick={() => setIsCreatingAlbum(false)} className="flex-1 bg-slate-100 py-1.5 rounded-lg text-[10px] font-bold">X</button>
                </div>
              </div>
            )}

            {currentItems.map(album => (
              <div key={album.id} onClick={() => setCurrentPath([...currentPath, album.id])}
                   className="group relative bg-white rounded-2xl border shadow-sm hover:shadow-xl transition-all cursor-pointer overflow-hidden border-transparent hover:border-indigo-100">
                <div className="aspect-square bg-slate-100 flex items-center justify-center relative">
                  {album.images?.[0] ? 
                    <img src={album.images[0].url} alt="" className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500" /> : 
                    <Folder size={40} className="text-slate-300 group-hover:text-indigo-400 transition-colors" />
                  }
                  <button 
                    onClick={(e) => deleteAlbum(e, album.id)} 
                    className="absolute top-2 right-2 p-1.5 bg-white/90 text-slate-400 hover:bg-red-500 hover:text-white rounded-lg opacity-0 group-hover:opacity-100 shadow-sm transition-all"
                  >
                    <Trash2 size={12} />
                  </button>
                  <div className="absolute bottom-2 right-2 bg-black/60 backdrop-blur-md px-2 py-0.5 rounded text-[9px] text-white font-bold">
                    {album.images?.length || 0}
                  </div>
                </div>
                <div className="p-3">
                  <h3 className="font-bold truncate text-slate-800 text-xs">{album.name}</h3>
                </div>
              </div>
            ))}

            {activePhotos.map((image, index) => (
              <div key={image.id} onClick={() => setViewerIndex(index)}
                   className="group relative bg-white rounded-xl border overflow-hidden shadow-sm hover:shadow-xl transition-all cursor-zoom-in">
                <div className="aspect-[4/3] bg-slate-200 overflow-hidden relative">
                  <img 
                    src={image.url} 
                    alt={image.name} 
                    className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-1000" 
                    loading="lazy"
                    onError={(e) => { e.target.src = 'https://placehold.co/400x300?text=Image+Unavailable'; }} 
                  />
                  <button 
                    onClick={(e) => deleteImage(e, image.id)} 
                    className="absolute top-2 right-2 p-1.5 bg-black/40 text-white rounded-lg opacity-0 group-hover:opacity-100 hover:bg-red-600 transition-all"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
                <div className="p-2 border-t flex justify-between items-center bg-white">
                  <p className="text-[9px] font-bold truncate text-slate-500 uppercase tracking-tighter w-full">{image.name}</p>
                </div>
              </div>
            ))}
            
            {currentPath.length > 0 && (
               <div onClick={() => fileInputRef.current?.click()} className="aspect-square rounded-2xl border-2 border-dashed border-slate-200 flex flex-col items-center justify-center gap-2 cursor-pointer hover:bg-indigo-50 hover:border-indigo-300 transition-all text-slate-300 hover:text-indigo-500 bg-white group active:scale-95">
                  <Plus size={24} className="group-hover:rotate-90 transition-transform duration-300" />
                  <span className="text-[9px] font-black uppercase tracking-widest">Add Photos</span>
                </div>
            )}
          </div>
          
          {albums.length === 0 && status === 'succeeded' && !isCreatingAlbum && (
            <div className="mt-20 flex flex-col items-center justify-center opacity-40">
              <Folder size={64} className="mb-4 text-indigo-300" />
              <p className="font-bold uppercase tracking-widest text-xs text-center leading-relaxed">Your cloud vault is empty.<br/>Create a folder to begin.</p>
            </div>
          )}
        </div>
      </main>

      {/* Lightbox Viewer */}
      {viewerIndex !== null && activePhotos[viewerIndex] && (
        <div className="fixed inset-0 z-[110] bg-slate-950/98 flex flex-col items-center justify-center animate-in fade-in duration-300">
          <button 
            onClick={() => setViewerIndex(null)} 
            className="absolute top-6 right-6 p-3 text-white hover:bg-white/10 rounded-full transition-all active:scale-90"
          >
            <X size={32} />
          </button>
          
          <div className="w-full flex items-center justify-between px-6 sm:px-10 absolute pointer-events-none">
             <button 
                onClick={(e) => { e.stopPropagation(); setViewerIndex(prev => (prev - 1 + activePhotos.length) % activePhotos.length); }}
                className="p-4 bg-white/5 hover:bg-white/20 text-white rounded-full pointer-events-auto transition-all active:scale-75 backdrop-blur-sm"
             >
                <ChevronLeft size={32} />
             </button>
             <button 
                onClick={(e) => { e.stopPropagation(); setViewerIndex(prev => (prev + 1) % activePhotos.length); }}
                className="p-4 bg-white/5 hover:bg-white/20 text-white rounded-full pointer-events-auto transition-all active:scale-75 backdrop-blur-sm"
             >
                <ChevronRight size={32} />
             </button>
          </div>

          <div className="w-full max-h-[80vh] flex items-center justify-center p-6">
            <img 
              src={activePhotos[viewerIndex].url} 
              alt="" 
              className="max-w-full max-h-full object-contain shadow-2xl rounded-lg animate-in zoom-in-95 duration-500" 
            />
          </div>
          
          <div className="absolute bottom-10 px-8 py-4 bg-white/10 backdrop-blur-2xl rounded-2xl border border-white/10 flex flex-col items-center gap-1 mx-4 text-center">
            <p className="text-white text-base font-black tracking-tight">{activePhotos[viewerIndex].name}</p>
            <p className="text-white/40 text-[10px] uppercase font-bold tracking-widest">{viewerIndex + 1} / {activePhotos.length}</p>
          </div>
        </div>
      )}

      {/* Hidden Inputs */}
      <input type="file" multiple accept="image/*" ref={fileInputRef} className="hidden" onChange={handleFileUpload} />
      <input type="file" webkitdirectory="true" directory="" ref={folderInputRef} className="hidden" onChange={handleFileUpload} />
    </div>
  );
};

export default App;