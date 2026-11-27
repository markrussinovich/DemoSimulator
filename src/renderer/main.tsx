import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Audience } from './player/Audience';
import './styles.css';
createRoot(document.getElementById('root')!).render(new URLSearchParams(location.search).has('audience') ? <Audience /> : <App />);
