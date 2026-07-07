import { app } from './app.js';

const PORT = process.env.PORT ?? 3001;

app.listen(PORT, () => {
  console.log(`SSO backend running on http://localhost:${PORT}`);
});
