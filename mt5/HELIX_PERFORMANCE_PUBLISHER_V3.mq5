// Read-only account statistics publisher. Contains no trading operations.
// Install on a separate chart in the HELIX QUADRIGA real account (magic 681000-681999 only).
#property strict
#property version "3.00"
#property description "HELIX performance publisher - reads history only, never trades"

input string InpAPIURL="https://helix-performance.robo-digimart31.workers.dev/api/publisher/mt5";
input string InpPublisherKey="";
input datetime InpHistoryFrom=D'2026.10.04 00:00:00'; // Broker/server time
input int InpSyncHours=12;
input int InpRetryMinutes=30;
datetime lastAttempt=0;
string syncKey;

string Escape(string value) {
   StringReplace(value,"\\","\\\\"); StringReplace(value,"\"","\\\"");
   StringReplace(value,"\r"," "); StringReplace(value,"\n"," "); StringReplace(value,"\t"," ");
   return value;
}
string Stamp(datetime value) { return TimeToString(value,TIME_DATE|TIME_SECONDS); }
string Decimal(double value) { return DoubleToString(value,8); }
bool Publish() {
   if(!TerminalInfoInteger(TERMINAL_CONNECTED)) { Print("HELIX: terminal disconnected; retry later."); return false; }
   if(AccountInfoInteger(ACCOUNT_TRADE_MODE)!=ACCOUNT_TRADE_MODE_REAL) { Print("HELIX: only the real account is allowed."); return false; }
   datetime brokerNow=TimeCurrent();
   if(!HistorySelect(InpHistoryFrom,brokerNow)) { Print("HELIX: could not load history.");return false; }
   int count=HistoryDealsTotal();
   long selected[];
   for(int i=0;i<count;i++) {
      ulong ticket=HistoryDealGetTicket(i);
      if(ticket==0) { Print("HELIX: incomplete history.");return false; }
      long magic=HistoryDealGetInteger(ticket,DEAL_MAGIC);
      long type=HistoryDealGetInteger(ticket,DEAL_TYPE);
      if((type==DEAL_TYPE_BUY || type==DEAL_TYPE_SELL) && magic>=681000 && magic<=681999) {
         int size=ArraySize(selected);ArrayResize(selected,size+1);
         selected[size]=HistoryDealGetInteger(ticket,DEAL_POSITION_ID);
      }
   }
   ArraySort(selected);
   int included=0;
   string deals="[";
   for(int i=0;i<count;i++) {
      ulong ticket=HistoryDealGetTicket(i);
      if(ticket==0) { Print("HELIX: incomplete history; retry later.");return false; }
      long type=HistoryDealGetInteger(ticket,DEAL_TYPE);
      if(type!=DEAL_TYPE_BUY && type!=DEAL_TYPE_SELL)continue;
      long position=HistoryDealGetInteger(ticket,DEAL_POSITION_ID);
      if(ArraySize(selected)==0)continue;
      int found=ArrayBsearch(selected,position);
      if(found<0 || selected[found]!=position)continue;
      if(included>=15000) { Print("HELIX: selected history exceeds 15000 deals.");return false; }
      if(included>0)deals+=",";
      included++;
      // Retain exits of HELIX positions even if closed manually (magic 0).
      // Foreign entries in a shared netting position are rejected server-side.
      deals+="{\"id\":\""+IntegerToString((long)ticket)+"\",\"time\":\""+Stamp((datetime)HistoryDealGetInteger(ticket,DEAL_TIME))+"\",";
      deals+="\"magic\":"+IntegerToString(HistoryDealGetInteger(ticket,DEAL_MAGIC))+",";
      deals+="\"type\":"+IntegerToString(HistoryDealGetInteger(ticket,DEAL_TYPE))+",";
      deals+="\"entry\":"+IntegerToString(HistoryDealGetInteger(ticket,DEAL_ENTRY))+",";
      deals+="\"position\":\""+IntegerToString(HistoryDealGetInteger(ticket,DEAL_POSITION_ID))+"\",";
      deals+="\"volume\":"+Decimal(HistoryDealGetDouble(ticket,DEAL_VOLUME))+",";
      deals+="\"profit\":"+Decimal(HistoryDealGetDouble(ticket,DEAL_PROFIT))+",";
      deals+="\"commission\":"+Decimal(HistoryDealGetDouble(ticket,DEAL_COMMISSION))+",";
      deals+="\"swap\":"+Decimal(HistoryDealGetDouble(ticket,DEAL_SWAP))+",";
      deals+="\"fee\":"+Decimal(HistoryDealGetDouble(ticket,DEAL_FEE))+"}";
   }
   deals+="]";
   string json="{\"version\":3,\"scope\":\"helix_magic_681\",\"account_type\":\"real\",";
   json+="\"account_login\":\""+IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN))+"\",";
   json+="\"broker\":\""+Escape(AccountInfoString(ACCOUNT_SERVER))+"\",";
   json+="\"currency\":\""+Escape(AccountInfoString(ACCOUNT_CURRENCY))+"\",";
   json+="\"symbol\":\""+Escape(_Symbol)+"\",";
   json+="\"history_from\":\""+Stamp(InpHistoryFrom)+"\",\"broker_now\":\""+Stamp(brokerNow)+"\",";
   json+="\"recorded_at_unix\":"+IntegerToString((long)TimeGMT())+",";
   json+="\"deals\":"+deals+"}";
   char body[],result[];string responseHeaders;
   int size=StringToCharArray(json,body,0,WHOLE_ARRAY,CP_UTF8);
   ArrayResize(body,size-1);
   if(ArraySize(body)>3000000) { Print("HELIX: payload too large.");return false; }
   ResetLastError();
   int status=WebRequest("POST",InpAPIURL,"Content-Type: application/json\r\nAuthorization: Bearer "+InpPublisherKey+"\r\n",15000,body,result,responseHeaders);
   if(status==200) { Print("HELIX Publisher V3: sync OK. Next update in ",InpSyncHours," hours.");return true; }
   Print("HELIX Publisher V3: HTTP=",status," MQL error=",GetLastError());
   // Only server-authored validation errors; never log outgoing payload/key.
   if(status==422 || status==409 || status==429)Print("HELIX: ",CharArrayToString(result,0,-1,CP_UTF8));
   return false;
}
int OnInit() {
   if(MQLInfoInteger(MQL_TESTER))return INIT_FAILED;
   if(InpHistoryFrom!=D'2026.10.04 00:00:00' || InpSyncHours<1 || InpRetryMinutes<5 || StringLen(InpPublisherKey)!=64) {
      Print("HELIX: load the supplied settings file; date/key/interval is invalid.");return INIT_PARAMETERS_INCORRECT;
   }
   if(InpAPIURL!="https://helix-performance.robo-digimart31.workers.dev/api/publisher/mt5") {
      Print("HELIX: unrecognized endpoint; stopped to protect the publisher key.");return INIT_PARAMETERS_INCORRECT;
   }
   syncKey="HELIX_PUB_V3_"+IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN));
   EventSetTimer(60);
   Print("HELIX Publisher V3 ready. Magic 681000-681999; history from 4 October 2026 broker time; profit only. No trading operations.");
   OnTimer();return INIT_SUCCEEDED;
}
void OnDeinit(const int reason) { EventKillTimer(); }
void OnTick() {}
void OnTimer() {
   datetime now=TimeGMT();
   double success=GlobalVariableCheck(syncKey)?GlobalVariableGet(syncKey):0;
   if(now-success<InpSyncHours*3600 || now-lastAttempt<InpRetryMinutes*60)return;
   lastAttempt=now;
   if(Publish())GlobalVariableSet(syncKey,(double)now);
}
