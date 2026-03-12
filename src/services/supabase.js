import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL  = 'https://jbzhordefdqplxjtxfji.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpiemhvcmRlZmRxcGx4anR4ZmppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMzMjk0NDEsImV4cCI6MjA4ODkwNTQ0MX0.Zy-5CqLory8qqz1lkXiunfCq_qTckQpEzZZxAX-ip2k';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);
