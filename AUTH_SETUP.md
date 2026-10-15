# הפעלת ניהול המשתמשים

המימוש מיועד למשק אחד. כולם רואים אותם נתונים; מנהל מוסיף ומוחק שיווקים ומנהל משתמשים, עובד מוסיף וצופה, וצופה קורא בלבד. ההרשאות נשמרות בטבלת `profiles`, לא במידע שהמשתמש יכול לערוך בעצמו.

## 1. משתני סביבה

ב־Vercel וב־`.env.local` יש להגדיר:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVER_ONLY_SERVICE_ROLE_KEY
APP_URL=https://avocado-system-theta.vercel.app
```

`SUPABASE_SERVICE_ROLE_KEY` הוא מפתח שרת בלבד, מתוך הגדרות ה־API של Supabase. אין להוסיף לו `NEXT_PUBLIC_`, לשלוח אותו בצ'אט או להכניס אותו ל־Git. רק נתיב ההזמנות בשרת משתמש בו. בדיקת זהות המנהל מתבצעת לפני השימוש בו. שם המשתנה הזה תומך גם במפתח Supabase מסוג secret המתאים לגישת שרת.

לסביבה מקומית: `APP_URL=http://localhost:3000`. לכל סביבת Preview יש להגדיר כתובת משלה, או להשתמש בפרויקט Supabase נפרד לבדיקה. אין לסמוך על Host שמגיע מהבקשה לצורך יצירת קישורי הזמנה.

## 2. הגדרות Supabase Auth

- להפעיל כניסה באמצעות אימייל וסיסמה, ולכבות **Allow new users to sign up**. מנהל עדיין יכול להזמין דרך Auth Admin API.
- לכבות Anonymous sign-ins וכל ספק כניסה שאינו בשימוש.
- תחת URL Configuration להגדיר Site URL לכתובת האתר הציבורי.
- להוסיף לרשימת Redirect URLs את `https://avocado-system-theta.vercel.app/**` ואת `http://localhost:3000/**` (ואת כתובות ה־Preview המורשות, אם יש).
- להשתמש בתבניות Invite ו־Reset Password המפנות ל־`{{ .ConfirmationURL }}`. בסיום אימות הקישור Supabase יחזיר את המשתמש ל־`/?auth=setup` או `/?auth=recovery` עם session; הלקוח מטפל בו ומציג הגדרת סיסמה.
- להגדיר SMTP לשליחת הזמנות למשתמשים אמיתיים. שירות האימייל המובנה עשוי להגביל נמענים וקצב שליחה.
- להגדיר דרישת סיסמה של לפחות 6 תווים גם בהגדרות Auth, בהתאם למינימום בממשק.

## 3. הכנת מנהל ראשון — לפני סגירת הגישה הציבורית

1. להריץ ב־SQL Editor את `supabase/migrations/001_users.sql` פעם אחת. זה יוצר פרופילים, פונקציות ניהול ויומן פעולות, אך עדיין לא משנה את הרשאות השיווקים הקיימות.
2. ב־Authentication → Users להזמין את **gury87@gmail.com** עם Redirect URL ל־`https://avocado-system-theta.vercel.app/?auth=setup`. אם כבר קיים חשבון Auth עם האימייל הזה, להשתמש בו ולשלוח שחזור סיסמה לפי הצורך.
3. להריץ את `supabase/bootstrap-admin.sql`. הוא מפעיל את החשבון כמנהל. המערכת לעולם אינה הופכת את הנרשם הראשון למנהל באופן אוטומטי.
4. לפרוס את הקוד עם משתני הסביבה. לפתוח את קישור ההזמנה, להגדיר שם וסיסמה ולוודא שניתן להיכנס כמנהל. אם הקישור פג תוקף, לשלוח שוב הזמנה/שחזור מה־Dashboard של Supabase.
5. **מיד לאחר כניסת המנהל**, להריץ `supabase/migrations/002_secure_farm.sql` פעם אחת. עד הרצת הקובץ הזה, הסתרת המסכים לבדה אינה מגינה על מסד הנתונים. אין להשאיר את המעבר במצב ביניים.

אפשר לבצע קודם את התהליך בסביבת בדיקה. כדי למנוע אפילו חלון ביניים של גישה ציבורית, ניתן להריץ את שלב 5 לפני הפריסה: האתר הישן לא יציג נתונים עד שהגרסה עם ההתחברות תעלה.

קובץ 002 שומר את הרשומות הקיימות, מוסיף `created_by` nullable, מחליף את מדיניות השיווקים ומפעיל RLS. הוא גם מוסיף שער חברות מגביל לכל טבלאות הנתונים הקיימות ב־public. ייתכן שטבלאות שטרם משמשות בממשק ידרשו מדיניות נוספת כשתתווסף אליהן גישה.

## 4. בדיקת הרשאות לפני פתיחת המערכת

- בחלון פרטי, ללא התחברות: מוצג מסך כניסה ואין גישה דרך REST לרשומות.
- מנהל: מזמין עובד וצופה, משנה תפקיד, חוסם ומפעיל; יכול להוסיף ולמחוק שיווק.
- עובד: קורא ומוסיף; בקשת DELETE ישירה לא מוחקת נתונים.
- צופה: קורא; INSERT ו־DELETE ישירים חסומים.
- משתמש חסום: גם עם access token קיים אינו יכול לקרוא או לשנות נתוני משק. ה־UI בודק מחדש הרשאות בכל חזרה לחלון ולכל היותר כל 30 שניות, ומסיר את המסכים כשהחשבון נחסם.
- ניסיון להעלות הרשאות דרך `profiles` או metadata נכשל. מנהל פעיל אחרון אינו ניתן לחסימה/הורדת תפקיד, גם כששתי פעולות מתרחשות במקביל.
- ביטול אישור מחיקה אינו שולח בקשת מחיקה; מחיקה מוצלחת מתועדת ב־`audit_log` עם מבצע, זמן ופרטי הרשומה.
- חשבון אישי: שם, שינוי סיסמה, שחזור סיסמה, יציאה וכניסה מחדש.

## 5. בדיקת שטח API קיים

אין בריפו סכמת מסד מלאה. לפני מעבר לייצור יש לבדוק ב־Supabase אם קיימים views או פונקציות RPC ישנות המאפשרות גישה לנתונים באמצעות `security definer` ומעקפות RLS. קובץ 002 מגן על טבלאות, אך אינו מוחק פונקציות או views לא מוכרים. views חשופים צריכים להשתמש ב־`security_invoker = true` או להסיר מהם גישה ל־anon/authenticated. יש לוודא שפונקציות קיימות מאמתות חברות והרשאות, או לשלול את הרשאות ההפעלה שלהן.

שאילתות לבדיקה ב־SQL Editor:

```sql
select schemaname, tablename, policyname, roles, cmd, qual, with_check
from pg_policies where schemaname = 'public';

select schemaname, viewname, definition from pg_views where schemaname = 'public';

select n.nspname, p.proname, p.prosecdef,
  has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public';
```

טבלאות חדשות שיתווספו בעתיד צריכות RLS ומדיניות מתאימה לפני חשיפה. `audit_log` זמין לקריאת מנהלים בלבד; כתיבתו נעשית על ידי triggers ופונקציות מבוקרות. אין מחיקת משתמשים פיזית בממשק — חסימה משמרת את הקישור להיסטוריית הפעולות.
