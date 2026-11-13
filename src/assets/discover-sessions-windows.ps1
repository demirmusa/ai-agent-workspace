$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public static class AiwsFileOwners {
 [StructLayout(LayoutKind.Sequential)] public struct UniqueProcess { public int pid; public System.Runtime.InteropServices.ComTypes.FILETIME start; }
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct Info {
  public UniqueProcess process;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string app;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string service;
  public uint type, status, session;
  [MarshalAs(UnmanagedType.Bool)] public bool restartable;
 }
 [DllImport("rstrtmgr.dll",CharSet=CharSet.Unicode)] static extern int RmStartSession(out uint session,int flags,string key);
 [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint session);
 [DllImport("rstrtmgr.dll",CharSet=CharSet.Unicode)] static extern int RmRegisterResources(uint session,uint files,string[] names,uint apps,UniqueProcess[] processes,uint services,string[] serviceNames);
 [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint session,out uint needed,ref uint count,[In,Out] Info[] infos,ref uint reasons);
 public static int[] Find(string path) {
  uint handle; if(RmStartSession(out handle,0,Guid.NewGuid().ToString("N"))!=0)return new int[0];
  try {
   if(RmRegisterResources(handle,1,new[]{path},0,null,0,null)!=0)return new int[0];
   uint needed=0,count=0,reasons=0; int code=RmGetList(handle,out needed,ref count,null,ref reasons);
   if(code!=234 || needed>256)return new int[0];
   var infos=new Info[needed]; count=needed;
   if(RmGetList(handle,out needed,ref count,infos,ref reasons)!=0)return new int[0];
   var result=new List<int>(); for(int i=0;i<count;i++) result.Add(infos[i].process.pid); return result.ToArray();
  } finally { RmEndSession(handle); }
 }
}
'@
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$processes = @(Get-CimInstance Win32_Process -Filter "Name = 'codex.exe' OR Name = 'claude.exe' OR Name = 'node.exe'" | Where-Object { $_.Name -ne 'node.exe' -or $_.CommandLine -match '[/\\](?:@anthropic-ai[/\\]claude-code|@openai[/\\]codex)[/\\]' } | ForEach-Object {
  @{ pid = $_.ProcessId; name = $_.Name; command = $_.CommandLine; startedAt = $_.CreationDate.ToUniversalTime().ToString('o') }
})
$owners = @{}
foreach ($path in $request.paths) { $owners[$path] = @([AiwsFileOwners]::Find($path)) }
@{ processes = $processes; owners = $owners } | ConvertTo-Json -Depth 6 -Compress
