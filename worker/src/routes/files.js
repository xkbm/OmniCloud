import { requireUser, sql } from '../db.js';
import { setStar, performRename, performDelete, performDownload, performCreateFolder, syncStorageAccount } from '../providers/storage.js';

function normalizePath(input = '/') {
  if (!input || input === '/') return '/';
  const clean = input.startsWith('/') ? input : `/${input}`;
  return clean.endsWith('/') ? clean : `${clean}/`;
}

function display(row) {
  const {
    encrypted_credentials: _encryptedCredentials,
    account_status: _accountStatus,
    ...safeRow
  } = row || {};
  return {
    ...safeRow,
    is_folder: Boolean(safeRow.is_folder),
    is_starred: Boolean(safeRow.is_starred),
    size: Number(safeRow.size || 0),
    createdTime: safeRow.remote_created_time || null,
    modifiedTime: safeRow.remote_modified_time || null,
    capabilities: { starred: safeRow.provider === 'google_drive', rename: true, delete: true },
  };
}

async function getFile(c, fileId) {
  const user = await requireUser(c); const db = sql(c.env);
  const rows = await db`SELECT fm.*, ca.provider, ca.email, ca.encrypted_credentials, ca.total_space, ca.used_space, ca.status AS account_status FROM file_metadata fm JOIN cloud_accounts ca ON ca.id=fm.cloud_account_id WHERE fm.user_id=${user.id} AND fm.id=${fileId} LIMIT 1`;
  return { user, row: rows[0] || null };
}

async function getAccount(c, accountId) {
  const user = await requireUser(c); const db = sql(c.env);
  const rows = await db`SELECT id,user_id,email,provider,encrypted_credentials,total_space,used_space,status FROM cloud_accounts WHERE id=${accountId} AND user_id=${user.id} LIMIT 1`;
  return rows[0] || null;
}

async function assertActive(row) {
  if (!row) throw Object.assign(new Error('File not found'), { status: 404 });
  if (row.account_status !== 'active') throw Object.assign(new Error('The file account is no longer connected'), { status: 409 });
}

const SAFE_INLINE_MIME_TYPES = new Set([
  'image/avif', 'image/bmp', 'image/gif', 'image/jpeg', 'image/png', 'image/webp',
  'audio/mpeg', 'audio/ogg', 'audio/wav',
  'video/mp4', 'video/mpeg', 'video/ogg', 'video/webm',
  'application/pdf', 'text/plain',
]);

const EXTENSION_MIME_TYPES = {
  avif: 'image/avif', bmp: 'image/bmp', gif: 'image/gif', jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav',
  mp4: 'video/mp4', mpeg: 'video/mpeg', mpg: 'video/mpeg', webm: 'video/webm',
  pdf: 'application/pdf', txt: 'text/plain',
};

function inferMimeType(fileName, currentMime) {
  const mime = String(currentMime || '').toLowerCase();
  if (SAFE_INLINE_MIME_TYPES.has(mime)) return mime;
  const extension = String(fileName || '').toLowerCase().split('.').pop() || '';
  return EXTENSION_MIME_TYPES[extension] || mime || 'application/octet-stream';
}

function safeDownloadFilename(value) {
  return String(value || 'download')
    .replace(/[\r\n]/g, '')
    .replaceAll('"', '')
    .slice(0, 180) || 'download';
}

export async function filesRoutes(app) {
  app.get('/api/files', async (c) => {
    try {
      const user = await requireUser(c); const db = sql(c.env); const search=String(c.req.query('search')||'').trim(); const path=normalizePath(c.req.query('path')||'/'); const limit=Math.max(1,Math.min(Number(c.req.query('limit')||100),200)); let rows;
      if(search) rows=await db`SELECT fm.*,ca.provider,ca.email FROM file_metadata fm JOIN cloud_accounts ca ON ca.id=fm.cloud_account_id WHERE fm.user_id=${user.id} AND ca.status='active' AND fm.file_name ILIKE ${`%${search}%`} ORDER BY fm.is_folder DESC,COALESCE(fm.remote_modified_time,fm.created_at) DESC,fm.file_name ASC LIMIT ${limit}`;
      else if(c.req.query('starred')==='1') rows=await db`SELECT fm.*,ca.provider,ca.email FROM file_metadata fm JOIN cloud_accounts ca ON ca.id=fm.cloud_account_id WHERE fm.user_id=${user.id} AND fm.is_starred=TRUE AND ca.status='active' ORDER BY COALESCE(fm.remote_modified_time,fm.remote_created_time) DESC,fm.file_name ASC`;
      else if(c.req.query('recent')==='1') rows=await db`SELECT fm.*,ca.provider,ca.email FROM file_metadata fm JOIN cloud_accounts ca ON ca.id=fm.cloud_account_id WHERE fm.user_id=${user.id} AND fm.is_folder=FALSE AND ca.status='active' ORDER BY COALESCE(fm.remote_modified_time,fm.remote_created_time) DESC,fm.file_name ASC LIMIT ${limit}`;
      else rows=await db`SELECT fm.*,ca.provider,ca.email FROM file_metadata fm JOIN cloud_accounts ca ON ca.id=fm.cloud_account_id WHERE fm.user_id=${user.id} AND fm.virtual_path=${path} AND ca.status='active' ORDER BY fm.is_folder DESC,fm.file_name ASC`;
      return c.json({data:rows.map(display)});
    } catch(error){return c.json({error:error?.message||'Request failed'},error?.status||(error instanceof Response?error.status:400));}
  });

  app.get('/api/files/:id', async(c)=>{try{const result=await getFile(c,c.req.param('id'));if(!result.row)return c.json({error:'File not found'},404);return c.json({data:display(result.row)});}catch(error){return c.json({error:error?.message||'Request failed'},error?.status||400);}});
  app.patch('/api/files/:id/star', async(c)=>{try{const result=await getFile(c,c.req.param('id'));await assertActive(result.row);const isStarred=Boolean((await c.req.json()).is_starred??true);const account=await getAccount(c,result.row.cloud_account_id);await setStar(c.env,account,result.row,isStarred);await sql(c.env)`UPDATE file_metadata SET is_starred=${isStarred},updated_at=NOW() WHERE id=${result.row.id} AND user_id=${result.user.id}`;return c.json({data:{success:true,is_starred:isStarred,provider_sync:true}});}catch(error){return c.json({error:error?.message||'Request failed'},error?.status||400);}});
  app.patch('/api/files/:id/rename', async(c)=>{try{const result=await getFile(c,c.req.param('id'));await assertActive(result.row);const name=String((await c.req.json()).name||'').trim();if(!name)return c.json({error:'New name is required'},400);if(name.length>255)return c.json({error:'New name is too long'},400);const account=await getAccount(c,result.row.cloud_account_id);await performRename(c.env,account,result.row,name);await sql(c.env)`UPDATE file_metadata SET file_name=${name},updated_at=NOW() WHERE id=${result.row.id} AND user_id=${result.user.id}`;return c.json({data:{success:true}});}catch(error){return c.json({error:error?.message||'Request failed'},error?.status||400);}});
  app.delete('/api/files/:id', async(c)=>{try{const result=await getFile(c,c.req.param('id'));await assertActive(result.row);const account=await getAccount(c,result.row.cloud_account_id);await performDelete(c.env,account,result.row);await sql(c.env)`DELETE FROM file_metadata WHERE id=${result.row.id} AND user_id=${result.user.id}`;return c.json({data:{success:true}});}catch(error){return c.json({error:error?.message||'Request failed'},error?.status||400);}});
  app.post('/api/files/bulk/delete', async(c)=>{try{const user=await requireUser(c);const ids=[...new Set((await c.req.json()).ids||[])].filter(Boolean);if(!ids.length)return c.json({error:'At least one file id is required'},400);if(ids.length>100)return c.json({error:'Too many files in one request'},400);const db=sql(c.env);const rows=await db`SELECT fm.*,ca.provider,ca.email,ca.encrypted_credentials,ca.status AS account_status FROM file_metadata fm JOIN cloud_accounts ca ON ca.id=fm.cloud_account_id WHERE fm.user_id=${user.id} AND fm.id=ANY(${ids})`;for(const row of rows){if(row.account_status!=='active')continue;const account={...row,id:row.cloud_account_id,user_id:user.id,email:row.email,provider:row.provider,encrypted_credentials:row.encrypted_credentials,status:row.account_status};await performDelete(c.env,account,row);}await db`DELETE FROM file_metadata WHERE user_id=${user.id} AND id=ANY(${ids})`;return c.json({data:{success:true,count:rows.length}});}catch(error){return c.json({error:error?.message||'Request failed'},error?.status||400);}});
  app.post('/api/files/folders',async(c)=>{try{const user=await requireUser(c);const body=await c.req.json();const name=String(body.name||'').trim();if(!name)return c.json({error:'Folder name is required'},400);if(name.length>255)return c.json({error:'Folder name is too long'},400);const db=sql(c.env);const requestedId=body.cloud_account_id||body.cloudAccountId||null;const rows=requestedId?await db`SELECT * FROM cloud_accounts WHERE id=${requestedId} AND user_id=${user.id} AND status='active' LIMIT 1`:await db`SELECT * FROM cloud_accounts WHERE user_id=${user.id} AND status='active' ORDER BY used_space ASC LIMIT 1`;const account=rows[0];if(!account)return c.json({error:'No active storage account is connected'},409);const folder=await performCreateFolder(c.env,account,{name,virtualPath:body.virtual_path||body.virtualPath||'/',remoteParentId:body.remote_parent_id||body.remoteParentId});await db`INSERT INTO file_metadata(id,user_id,virtual_path,file_name,is_folder,is_starred,size,mime_type,cloud_account_id,remote_file_id,remote_parent_id) VALUES(${crypto.randomUUID()},${user.id},${normalizePath(body.virtual_path||body.virtualPath||'/')},${folder.fileName||name},TRUE,FALSE,0,'application/vnd.google-apps.folder',${account.id},${folder.remoteFileId},${folder.remoteParentId||null}) ON CONFLICT(cloud_account_id,remote_file_id) DO UPDATE SET file_name=EXCLUDED.file_name,virtual_path=EXCLUDED.virtual_path,updated_at=NOW()`;return c.json({data:{success:true,file:folder}},201);}catch(error){return c.json({error:error?.message||'Request failed'},error?.status||400);}});

  async function download(c,inline){
    const result=await getFile(c,c.req.param('id'));
    await assertActive(result.row);
    if(result.row.is_folder)throw Object.assign(new Error('Folders cannot be downloaded'),{status:400});
    const account=await getAccount(c,result.row.cloud_account_id);
    const mime= inferMimeType(result.row.file_name, result.row.mime_type);
    const allowInline=inline && SAFE_INLINE_MIME_TYPES.has(mime);
    const response=await performDownload(c.env,account,result.row);
    const headers=new Headers(response.headers);
    headers.set('Content-Disposition',`${allowInline?'inline':'attachment'}; filename="${safeDownloadFilename(result.row.file_name)}"`);
    if(allowInline) headers.set('Content-Type',mime);
    else if(!headers.get('Content-Type') || headers.get('Content-Type') === 'application/octet-stream') headers.set('Content-Type','application/octet-stream');
    headers.set('X-Content-Type-Options','nosniff');
    headers.set('Cache-Control','private, no-store');
    return new Response(response.body,{status:response.status,headers});
  }
  app.get('/api/files/:id/download',async(c)=>{try{return await download(c,false);}catch(error){return c.json({error:error?.message||'Download failed'},error?.status||400);}});
  app.get('/api/files/:id/preview',async(c)=>{try{return await download(c,true);}catch(error){return c.json({error:error?.message||'Preview failed'},error?.status||400);}});
  app.post('/api/sync/run',async(c)=>{try{const user=await requireUser(c);const db=sql(c.env);const accounts=await db`SELECT * FROM cloud_accounts WHERE user_id=${user.id} AND status='active'`;const results=[];for(const account of accounts){try{results.push({accountId:account.id,provider:account.provider,...(await syncStorageAccount(c.env,user.id,account))});}catch(error){results.push({accountId:account.id,provider:account.provider,error:error?.message||'Sync failed'});}}return c.json({data:{success:true,results}});}catch(error){return c.json({error:error?.message||'Sync failed'},error?.status||400);}});
}
