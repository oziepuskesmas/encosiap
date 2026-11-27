import{SUPABASE_URL as a,SUPABASE_ANON_KEY as t,getSession as e,authFetch as n,authedFetch as r,registerDevice as o,verifyDevice as i,getUserData as s,insertPendaftaranRecord as l,insertAutomationRecord as c,updatePendaftaranRecordStatus as d,getPendaftaranRecordByNik as u}from"./supabase.js";

export async function signInWithGoogle(){
  const mockSession = {
    accessToken: "bypassed-local-token",
    refreshToken: "bypassed-local-refresh",
    user: {
      id: "local-user-id",
      email: "offline@local",
      user_metadata: { full_name: "Offline User" }
    }
  };
  await chrome.storage.local.set({session: mockSession});
  return mockSession;
}

export async function signOut(){ return; }

export const verifyDevice = async () => true;
export const getUserData = async () => ({ id: "local-user-id", plan_expires_at: "2099-12-31T23:59:59Z" });

export async function ensurePendaftaranRecord({patientData:a,startedAt:t}){ return; }
export async function insertAutomationRecord({patientData:a,progress:t,attempted:n,succeeded:r,stopped:o=!1,startedAt:i}){ return; }

export{getSession,getPendaftaranRecords,getPendaftaranRecordByNik,insertPendaftaranRecord,clearPendaftaranRecords,syncPendaftaranPatientsToDatabase}from"./supabase.js";