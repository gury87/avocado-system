מערכת ניהול מטעי אבוקדו — Next.js, React ו־Supabase.

הפעלת מסך הגדרות המשק, ניהול רשימות, סימון שיווקים פתוחים, פחת ויבול לדונם: [SETTINGS_SETUP.md](./SETTINGS_SETUP.md).

הפעלת דוחות סוחרים, מחירים, סיכום עונה, ייצוא לאקסל ומסמכים פרטיים: [REPORTS_SETUP.md](./REPORTS_SETUP.md).

הפעלת התחברות, חשבון מנהל ראשון, הזמנות והרשאות: [AUTH_SETUP.md](./AUTH_SETUP.md).

הפעלת מסך התקבולים ויצירת טבלאות ופונקציות ב־Supabase: [RECEIPTS_SETUP.md](./RECEIPTS_SETUP.md).

הפעלת עריכת שיווקים: [SHIPMENTS_SETUP.md](./SHIPMENTS_SETUP.md).

בדיקות הרשאות מסד נתונים: `npm run test:auth` (PostgreSQL מקומי דרך PGlite, ללא שינוי מסד הנתונים האמיתי).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
