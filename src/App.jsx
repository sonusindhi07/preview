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
  Layers,
  FolderUp,
  Loader2,
  ChevronRightSquare,
  FileUp,
  CheckCircle2,
  AlertCircle
} from 'lucide-react';

// --- API CONFIGURATION ---
// Using the user-provided MockAPI endpoint
const API_BASE = "https://694d4185ad0f8c8e6e203206.mockapi.io/albums";

// --- STATE MANAGEMENT ---
const initialState = {
  items: [],
  status: 'idle', // 'idle' | 'loading' | 'succeeded' | 'failed'
  error: null,
  syncing: false
};

function albumReducer(state, action) {
  switch (action.type) {
    case 'FETCH_START':
      return { ...state, status: 'loading' };
    case 'FETCH_SUCCESS':
      return { ...state, status: 'succeeded', items: action.payload };
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
  const [showAllNested, setShowAllNested] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  // --- UPLOAD PROGRESS STATE ---
  const [uploadProgress, setUploadProgress] = useState({ active: false, percent: 0, fileName: '' });
  
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);

  // --- BACKEND API ACTIONS ---
  
  // Exponential backoff fetch helper
  const fetchWithRetry = async (url, options = {}, retries = 5, backoff = 1000) => {
    try {
      const response = await fetch(url, options);
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      return await response.json();
    } catch (err) {
      if (retries > 0) {
        await new Promise(resolve => setTimeout(resolve, backoff));
        return fetchWithRetry(url, options, retries - 1, backoff * 2);
      }
      throw err;
    }
  };

  const fetchAlbums = async () => {
    dispatch({ type: 'FETCH_START' });
    try {
      const data = await fetchWithRetry(API_BASE);
      // MockAPI returns an array. We look for our specific document "1"
      const remoteEntry = data.find(item => item.id === "1");
      dispatch({ type: 'FETCH_SUCCESS', payload: remoteEntry?.data || [] });
    } catch (err) {
      dispatch({ type: 'FETCH_ERROR', payload: "Failed to connect to backend storage." });
    }
  };

  const syncToBackend = async (newAlbums) => {
    dispatch({ type: 'SYNC_START' });
    try {
      // We check if document "1" exists by trying to PUT to it
      const response = await fetch(`${API_BASE}/1`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: newAlbums })
      });

      // If PUT fails (404), it means the collection is empty, so we POST the first record
      if (!response.ok) {
        await fetch(API_BASE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: "1", data: newAlbums })
        });
      }
    } catch (err) {
      console.error("Cloud sync failed:", err);
    } finally {
      dispatch({ type: 'SYNC_END' });
    }
  };

  const persistChanges = (newAlbums) => {
    // Update UI immediately (Optimistic UI)
    dispatch({ type: 'SET_ITEMS', payload: newAlbums });
    // Sync to MockAPI in the background
    syncToBackend(newAlbums);
  };

  useEffect(() => {
    fetchAlbums();
  }, []);

  // --- NAVIGATION HELPERS ---
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

  const getAllPhotosRecursive = useCallback((album, pathName = "") => {
    const currentName = pathName ? `${pathName} / ${album.name}` : album.name;
    let photos = (album.images || []).map(img => ({ ...img, folderName: currentName }));
    if (album.subAlbums) {
      album.subAlbums.forEach(sub => {
        photos = [...photos, ...getAllPhotosRecursive(sub, currentName)];
      });
    }
    return photos;
  }, []);

  const activePhotos = useMemo(() => {
    const album = getCurrentAlbum();
    if (!album) return [];
    return showAllNested ? getAllPhotosRecursive(album) : (album.images || []);
  }, [getCurrentAlbum, showAllNested, getAllPhotosRecursive]);

  const navigateUp = () => {
    setCurrentPath(prev => prev.slice(0, -1));
    setShowAllNested(false);
  };

  // --- SIMULATED UPLOAD DELAY ---
  const simulateUpload = async (name) => {
    setUploadProgress({ active: true, percent: 0, fileName: name });
    for (let i = 0; i <= 100; i += 20) {
      setUploadProgress(prev => ({ ...prev, percent: i }));
      await new Promise(r => setTimeout(r, 100));
    }
    await new Promise(r => setTimeout(r, 200));
    setUploadProgress({ active: false, percent: 0, fileName: '' });
  };

  // --- RECURSIVE FOLDER PROCESSING ---
  const processEntry = async (entry, targetList) => {
    if (entry.isFile) {
      const file = await new Promise((resolve) => entry.file(resolve));
      if (file.type.startsWith('image/')) {
        targetList.images.push({
          id: Math.random().toString(36).substr(2, 9),
          name: file.name,
          url: URL.createObjectURL(file), // Note: In a real app, you'd upload this to S3/Cloudinary and store the URL
          size: (file.size / 1024).toFixed(1) + ' KB'
        });
      }
    } else if (entry.isDirectory) {
      let folder = targetList.subAlbums.find(f => f.name === entry.name);
      if (!folder) {
        folder = { id: Math.random().toString(36).substr(2, 9), name: entry.name, images: [], subAlbums: [] };
        targetList.subAlbums.push(folder);
      }
      
      const dirReader = entry.createReader();
      const entries = await new Promise((resolve) => dirReader.readEntries(resolve));
      for (const childEntry of entries) {
        await processEntry(childEntry, folder);
      }
    }
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    setIsDragging(false);
    
    const items = e.dataTransfer.items;
    if (!items) return;

    await simulateUpload("Batch Uploading Folders...");

    const nextAlbums = JSON.parse(JSON.stringify(albums));
    let targetNode = { subAlbums: nextAlbums, images: [] };

    if (currentPath.length > 0) {
      let current = nextAlbums;
      let found = null;
      for (const id of currentPath) {
        found = current.find(a => a.id === id);
        if (found) current = found.subAlbums;
      }
      if (found) targetNode = found;
    }

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const entry = item.webkitGetAsEntry();
        if (entry) await processEntry(entry, targetNode);
      }
    }

    persistChanges(nextAlbums);
  };

  const createAlbum = () => {
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
    persistChanges(nextAlbums);
    setNewAlbumName('');
    setIsCreatingAlbum(false);
  };

  const deleteAlbum = (e, id) => {
    if (e) e.stopPropagation();
    const deleteRecursive = (list) => {
      return list.filter(item => {
        if (item.id === id) return false;
        if (item.subAlbums) {
          item.subAlbums = deleteRecursive(item.subAlbums);
        }
        return true;
      });
    };
    persistChanges(deleteRecursive([...albums]));
  };

  const handleFileUpload = async (e) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    if (!files.length || currentPath.length === 0) return;

    const fileNameLabel = files.length === 1 ? files[0].name : `${files.length} images`;
    await simulateUpload(fileNameLabel);

    const newImages = files.map(file => ({
      id: Math.random().toString(36).substr(2, 9),
      name: file.name,
      url: URL.createObjectURL(file),
      size: (file.size / 1024).toFixed(1) + ' KB'
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
    persistChanges(updateRecursive(albums));
    e.target.value = '';
  };

  const deleteImage = useCallback((e, imageId) => {
    if (e) e.stopPropagation();
    const deleteFromRecursive = (list) => {
      return list.map(item => {
        const newItem = { ...item };
        if (newItem.images) newItem.images = newItem.images.filter(img => img.id !== imageId);
        if (newItem.subAlbums) newItem.subAlbums = deleteFromRecursive(newItem.subAlbums);
        return newItem;
      });
    };
    persistChanges(deleteFromRecursive([...albums]));
  }, [albums]);

  const navigateViewer = useCallback((direction) => {
    if (viewerIndex === null || activePhotos.length === 0) return;
    setViewerIndex((prev) => (prev + direction + activePhotos.length) % activePhotos.length);
  }, [viewerIndex, activePhotos]);

  // --- KEYBOARD CONTROLS ---
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (viewerIndex !== null) setViewerIndex(null);
        else if (isCreatingAlbum) { setIsCreatingAlbum(false); setNewAlbumName(''); }
      }
      if (viewerIndex !== null) {
        if (e.key === 'ArrowRight') navigateViewer(1);
        else if (e.key === 'ArrowLeft') navigateViewer(-1);
        else if (e.key === 'Delete' || e.key === 'Backspace') {
          const currentImageId = activePhotos[viewerIndex]?.id;
          if (currentImageId) {
            deleteImage(null, currentImageId);
            if (activePhotos.length <= 1) setViewerIndex(null);
          }
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [viewerIndex, isCreatingAlbum, activePhotos, navigateViewer, deleteImage]);

  const currentAlbum = getCurrentAlbum();
  const currentItems = getCurrentDirectory();

  if (status === 'loading' && albums.length === 0) {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center bg-white">
        <Loader2 className="w-10 h-10 text-blue-600 animate-spin mb-4" />
        <p className="text-sm font-black text-slate-400 uppercase tracking-widest">Connecting to Cloud...</p>
      </div>
    );
  }

  if (status === 'failed') {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center bg-white px-6 text-center">
        <div className="bg-red-50 p-6 rounded-3xl mb-4 text-red-500">
          <AlertCircle size={48} />
        </div>
        <h2 className="text-2xl font-black text-slate-800 mb-2">Backend Connection Failed</h2>
        <p className="text-slate-500 max-w-sm mb-6">{error}</p>
        <button onClick={fetchAlbums} className="bg-blue-600 text-white px-8 py-3 rounded-2xl font-bold shadow-xl shadow-blue-100">
          Retry Connection
        </button>
      </div>
    );
  }

  return (
    <div 
      className="flex flex-col h-screen bg-slate-50 text-slate-900 font-sans overflow-hidden relative"
      onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
    >
      {/* Cloud Sync Indicator */}
      {syncing && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 bg-white/90 backdrop-blur shadow-2xl border px-4 py-2 rounded-full flex items-center gap-2 animate-in fade-in slide-in-from-top-4">
          <Loader2 size={12} className="text-blue-600 animate-spin" />
          <span className="text-[10px] font-black uppercase tracking-tighter text-slate-600">Syncing to MockAPI</span>
        </div>
      )}

      {/* Upload Progress Notification */}
      {uploadProgress.active && (
        <div className="fixed bottom-6 right-6 z-[60] w-80 bg-white rounded-2xl shadow-2xl border p-4 animate-in slide-in-from-bottom-4 duration-300">
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2 bg-blue-100 rounded-lg">
              <Upload size={18} className="text-blue-600 animate-pulse" />
            </div>
            <div className="flex-1 min-w-0">
              <h4 className="text-xs font-black uppercase tracking-wider text-slate-800 truncate">Uploading...</h4>
              <p className="text-[10px] text-slate-500 truncate font-medium">{uploadProgress.fileName}</p>
            </div>
            <span className="text-[10px] font-black text-blue-600">{uploadProgress.percent}%</span>
          </div>
          <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
            <div className="h-full bg-blue-600 transition-all duration-300 ease-out" style={{ width: `${uploadProgress.percent}%` }} />
          </div>
        </div>
      )}

      {/* Global Drag Overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-50 bg-blue-600/90 backdrop-blur-sm flex items-center justify-center border-8 border-dashed border-white/50 m-4 rounded-3xl pointer-events-none animate-in zoom-in duration-200">
          <div className="flex flex-col items-center gap-6 text-white text-center">
            <div className="bg-white/20 p-8 rounded-full"><FileUp size={80} className="animate-bounce" /></div>
            <div className="space-y-2">
              <h3 className="text-4xl font-black">Drop to Cloud</h3>
              <p className="text-xl font-medium opacity-80">Syncing folders directly to backend storage</p>
            </div>
          </div>
        </div>
      )}

      <header className="bg-white border-b flex-shrink-0 z-20 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 cursor-pointer min-w-fit" onClick={() => {setCurrentPath([]); setShowAllNested(false);}}>
            <div className="bg-blue-600 p-2 rounded-xl shadow-lg shadow-blue-200">
              <ImageIcon className="text-white w-5 h-5" />
            </div>
            <h1 className="text-xl font-black tracking-tight text-slate-800">PhotoVault</h1>
          </div>
          
          <div className="flex items-center gap-2 overflow-x-auto no-scrollbar py-1">
            <button 
              onClick={() => folderInputRef.current?.click()}
              className="bg-white border text-slate-600 hover:text-blue-600 px-3 py-2 rounded-full text-xs font-bold transition-all flex items-center gap-2 flex-shrink-0"
            >
              <FolderUp size={14} /> <span>Bulk Upload</span>
            </button>

            {currentPath.length > 0 && (
              <>
                <button 
                  onClick={() => setShowAllNested(!showAllNested)}
                  className={`px-3 py-2 rounded-full text-xs font-bold transition-all flex items-center gap-2 flex-shrink-0 ${
                    showAllNested ? 'bg-blue-100 text-blue-700 ring-2 ring-blue-500' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  <Layers size={14} /> <span>{showAllNested ? 'Deep View' : 'Folder View'}</span>
                </button>
                <button 
                  onClick={() => fileInputRef.current?.click()}
                  className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-2 rounded-full text-xs font-bold shadow-md flex items-center gap-2 flex-shrink-0"
                >
                  <Upload size={14} /> <span>Add Pics</span>
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto overflow-x-hidden">
        <div className="max-w-7xl mx-auto px-4 py-8">
          <div className="mb-6 flex items-center gap-2 text-[11px] text-slate-400 font-black tracking-widest uppercase overflow-x-auto no-scrollbar whitespace-nowrap bg-white border px-4 py-3 rounded-2xl shadow-sm">
            <span className="hover:text-blue-600 cursor-pointer flex-shrink-0" onClick={() => {setCurrentPath([]); setShowAllNested(false);}}>Root</span>
            {currentPath.map((id, idx) => {
               let list = albums;
               for (let i = 0; i < idx; i++) list = list.find(a => a.id === currentPath[i])?.subAlbums || [];
               const folder = list.find(a => a.id === id);
               return (
                 <React.Fragment key={id}>
                   <ChevronRight size={14} className="flex-shrink-0 text-slate-300" />
                   <span className={`cursor-pointer hover:text-blue-600 flex-shrink-0 ${idx === currentPath.length - 1 ? 'text-blue-600' : ''}`}
                         onClick={() => {setCurrentPath(currentPath.slice(0, idx+1)); setShowAllNested(false);}}>
                     {folder?.name}
                   </span>
                 </React.Fragment>
               );
            })}
          </div>

          <div className="mb-8 flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              {currentPath.length > 0 && (
                <button onClick={navigateUp} className="p-3 bg-white border rounded-2xl hover:bg-slate-50 transition-colors shadow-sm">
                  <ChevronLeft size={20} />
                </button>
              )}
              <div>
                <h2 className="text-3xl font-black text-slate-800 tracking-tight flex items-center gap-3">
                  {currentPath.length === 0 ? "Collections" : currentAlbum?.name}
                  {currentPath.length > 1 && <span className="text-slate-200 font-light text-xl">/</span>}
                  <span className="text-slate-300 text-lg font-medium">
                    {currentPath.length > 1 ? albums.find(a => a.id === currentPath[0])?.name : ""}
                  </span>
                </h2>
                <p className="text-slate-400 text-[10px] font-black tracking-[0.2em] mt-1 uppercase">
                  {showAllNested ? `${activePhotos.length} Total Items` : `${currentItems.length} Folders • ${(currentAlbum?.images || []).length} Photos`}
                </p>
              </div>
            </div>
            
            {!showAllNested && (
              <button 
                onClick={() => setIsCreatingAlbum(true)}
                className="bg-white border-2 border-slate-200 text-slate-700 hover:border-blue-500 hover:text-blue-600 px-6 py-2.5 rounded-2xl font-bold transition-all flex items-center gap-2 shadow-sm text-sm"
              >
                <FolderPlus size={18} /> New Folder
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 sm:gap-6">
            {isCreatingAlbum && (
              <div className="bg-white p-4 rounded-2xl border-2 border-dashed border-blue-400 flex flex-col gap-3 shadow-xl ring-4 ring-blue-50 animate-in zoom-in duration-200">
                <input 
                  autoFocus
                  className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-blue-500 text-xs font-bold"
                  placeholder="Folder name..."
                  value={newAlbumName}
                  onChange={(e) => setNewAlbumName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && createAlbum()}
                />
                <div className="flex gap-2">
                  <button onClick={createAlbum} className="flex-1 bg-blue-600 text-white py-2 rounded-lg text-[10px] font-black uppercase">Create</button>
                  <button onClick={() => {setIsCreatingAlbum(false); setNewAlbumName('');}} className="flex-1 bg-slate-100 py-2 rounded-lg text-[10px] font-bold">Cancel</button>
                </div>
              </div>
            )}

            {!showAllNested && currentItems.map(album => (
              <div key={album.id} onClick={() => {setCurrentPath([...currentPath, album.id]); setShowAllNested(false);}}
                   className="group relative bg-white rounded-2xl border shadow-sm hover:shadow-xl transition-all cursor-pointer overflow-hidden border-slate-200">
                <div className="aspect-square bg-slate-100 flex items-center justify-center relative overflow-hidden">
                  {album.images?.[0] ? (
                    <img src={album.images[0].url} alt="" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                  ) : (
                    <div className="flex flex-col items-center gap-2 opacity-30"><Folder size={48} className="text-slate-400" /></div>
                  )}
                  <div className="absolute inset-x-0 bottom-0 p-2 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                    <p className="text-[9px] text-white font-black uppercase tracking-widest flex items-center gap-1">
                      <ChevronRightSquare size={10} /> Open Folder
                    </p>
                  </div>
                  <button onClick={(e) => deleteAlbum(e, album.id)}
                          className="absolute top-2 right-2 p-2 bg-white/90 text-slate-400 hover:bg-red-500 hover:text-white rounded-full opacity-0 group-hover:opacity-100 transition-all shadow-md">
                    <Trash2 size={14} />
                  </button>
                </div>
                <div className="p-3 border-t bg-white">
                  <h3 className="font-bold truncate text-slate-800 text-sm">{album.name}</h3>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-[9px] text-blue-500 font-black uppercase tracking-tighter">{album.images?.length || 0} pics</span>
                    <span className="text-[9px] text-slate-300 font-black">•</span>
                    <span className="text-[9px] text-slate-400 font-black uppercase tracking-tighter">{album.subAlbums?.length || 0} folders</span>
                  </div>
                </div>
              </div>
            ))}

            {activePhotos.map((image, index) => (
              <div key={image.id} onClick={() => setViewerIndex(index)}
                   className="group relative bg-white rounded-xl border-2 overflow-hidden shadow-sm hover:ring-2 hover:ring-blue-500 border-white transition-all cursor-zoom-in">
                <div className="aspect-[4/3] relative overflow-hidden bg-slate-200">
                  <img src={image.url} alt="" className="w-full h-full object-cover transition-transform group-hover:scale-110 duration-700" />
                  <button onClick={(e) => deleteImage(e, image.id)}
                          className="absolute top-2 right-2 p-2 bg-black/60 text-white rounded-lg opacity-0 group-hover:opacity-100 hover:bg-red-600 transition-all z-10 backdrop-blur-md">
                    <Trash2 size={12} />
                  </button>
                </div>
                <div className="p-2 bg-white">
                  <p className="text-[10px] font-bold truncate text-slate-700 leading-tight">{image.name}</p>
                  {showAllNested && (
                    <div className="flex items-center gap-1 mt-1 opacity-60">
                      <Folder size={8} className="text-blue-500" />
                      <p className="text-[8px] text-blue-500 uppercase font-black truncate">{image.folderName}</p>
                    </div>
                  )}
                </div>
              </div>
            ))}
            
            {currentPath.length > 0 && !showAllNested && (
               <div onClick={() => fileInputRef.current?.click()}
                    className="aspect-square rounded-2xl border-2 border-dashed border-slate-300 flex flex-col items-center justify-center gap-2 cursor-pointer hover:bg-blue-50 transition-all text-slate-400 hover:text-blue-500 bg-white group hover:border-blue-300">
                  <Plus size={28} className="group-hover:scale-110 transition-transform" />
                  <span className="text-[9px] font-black uppercase tracking-widest">Add Item</span>
                </div>
            )}
          </div>
          <div className="h-20" />
        </div>
      </main>

      {/* Viewer Overlay */}
      {viewerIndex !== null && activePhotos[viewerIndex] && (
        <div className="fixed inset-0 z-50 bg-black/98 flex flex-col items-center justify-center backdrop-blur-xl animate-in fade-in duration-300">
          <div className="absolute top-0 w-full p-6 flex justify-between items-center text-white z-10">
            <div className="flex flex-col">
              <span className="text-lg font-black truncate max-w-xs">{activePhotos[viewerIndex].name}</span>
              <span className="text-[10px] text-slate-400 font-bold uppercase tracking-[0.2em] mt-1 flex items-center gap-2">
                <Folder size={10} /> {activePhotos[viewerIndex].folderName || currentAlbum?.name} &bull; {viewerIndex + 1} / {activePhotos.length}
              </span>
            </div>
            <button onClick={() => setViewerIndex(null)} className="p-3 bg-white/5 hover:bg-white/20 rounded-full transition-all ring-1 ring-white/10"><X size={28} /></button>
          </div>
          <button onClick={() => navigateViewer(-1)} className="absolute left-6 p-5 text-white bg-white/5 hover:bg-white/20 rounded-full hidden md:block transition-all"><ChevronLeft size={40} /></button>
          <button onClick={() => navigateViewer(1)} className="absolute right-6 p-5 text-white bg-white/5 hover:bg-white/20 rounded-full hidden md:block transition-all"><ChevronRight size={40} /></button>
          <div className="w-full max-h-[75vh] flex items-center justify-center p-4">
            <img src={activePhotos[viewerIndex].url} alt="" className="max-w-full max-h-full object-contain shadow-2xl rounded-sm" />
          </div>
          <div className="absolute bottom-8 w-full">
             <div className="flex justify-center gap-3 overflow-x-auto no-scrollbar py-4 px-10 max-w-4xl mx-auto">
              {activePhotos.map((img, idx) => (
                <img key={img.id} src={img.url} onClick={() => setViewerIndex(idx)}
                     className={`h-16 w-16 flex-shrink-0 object-cover rounded-xl cursor-pointer transition-all duration-300 border-2 ${idx === viewerIndex ? 'border-blue-500 scale-125 ring-4 ring-blue-500/20 brightness-110 z-10' : 'border-transparent opacity-30 hover:opacity-100 hover:scale-110'}`} />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Inputs */}
      <input type="file" multiple accept="image/*" ref={fileInputRef} className="hidden" onChange={handleFileUpload} />
      <input type="file" webkitdirectory="true" directory="" ref={folderInputRef} className="hidden" onChange={handleFileUpload} />

      <style dangerouslySetInnerHTML={{ __html: `
        .no-scrollbar::-webkit-scrollbar { display: none; }
        .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
      `}} />
    </div>
  );
};

export default App;