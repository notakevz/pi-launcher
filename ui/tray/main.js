import { createApp } from 'vue';
import PrimeVue from 'primevue/config';
import Aura from '@primeuix/themes/aura';
import TrayApp from './TrayApp.vue';
import './tray.css';

createApp(TrayApp)
  .use(PrimeVue, {
    ripple: false,
    theme: { preset: Aura, options: { darkModeSelector: 'system' } },
  })
  .mount('#app');
