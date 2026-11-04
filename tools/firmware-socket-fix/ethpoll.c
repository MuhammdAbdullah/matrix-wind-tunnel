  {
    MX_UINT8 sr;
    MX_UINT16 rsr;
    MX_UINT16 rd;
    MX_UINT8 reopen = 0;
    MX_UINT8 commit = 0;
    MX_UINT8 wipe = 0;
    MX_UINT8 pk[20];

    FCV_ETHCLIENTCONNECTED = 0;

    /* Only read USB while a host has configured the device. The CDC read (getsUSBUSART) treats a missing descriptor
       handle as "a packet is ready" and hands back the old contents of its receive buffer on every call, so with no
       cable the controller replayed the last commands it ever received (zeromotor, version ...) thousands of times,
       kept the stepper and main loop busy, looked like a live USB host and mixed the stale messages into the queue. */
    FCV_COMMSUSBACTIVE = (((MX_UINT8)USBDeviceState) >= 0x20) ? 1 : 0;

    sr = FCD_066a1_TCP_IP_W5500__GetSocketStatus(0);
    FCD_066a1_TCP_IP_W5500__MAC_SetRegister(0);
    rsr = FCD_066a1_TCP_IP_W5500__MAC_ReadWord(FCV_066a1_TCP_IP_W5500__SN_RX_RSR);
    rd = FCD_066a1_TCP_IP_W5500__MAC_ReadWord(FCV_066a1_TCP_IP_W5500__SN_RX_RD);

    if (FCD_05c71_WebSocket1__IsConnected())
    {
      FCV_ETHIDLE = 0;
      if (sr != 0x17 && rsr == 0)
      {
        /* The client went away (FIN or RST) without sending a WebSocket close frame */
        FCV_ETHSEEN = 0;
        FCD_05c71_WebSocket1__Prv_CloseLink();
        FCV_ETHCLIENTCONNECTED = 3;
        wipe = 1;
      }
      else
      {
        MX_UINT8 go = 1;

        /* The component re-reads bytes it has not been told are consumed, so a frame that is only partly
           here would be decoded from stale data. Read a frame only when all of it has arrived. */
        if (FCV_05061_NetworkComms1__RXCOUNT == 0 && rsr > 0)
        {
          MX_UINT16 n = rsr;
          MX_UINT16 need;
          MX_UINT16 flen;

          if (n > 14) { n = 14; }
          FCV_066a1_TCP_IP_W5500__GRXPTR[0] = rd;
          FCD_066a1_TCP_IP_W5500__RxReadArray(0, pk, 20, n);
          need = 2;
          if (n >= 2)
          {
            flen = pk[1] & 0x7F;
            need = 2;
            if (flen == 126)
            {
              need = 4;
              if (n >= 4) { flen = ((MX_UINT16)pk[2] << 8) | pk[3]; } else { flen = 0xFFFF; }
            }
            else if (flen == 127)
            {
              need = 10;
              if (n >= 10) { flen = ((MX_UINT16)pk[8] << 8) | pk[9]; } else { flen = 0xFFFF; }
            }
            if (pk[1] & 0x80) { need = need + 4; }
            if (flen > 2000) { need = 0xFFFF; } else { need = need + flen; }
          }
          if (rsr < need)
          {
            go = 0;
            FCV_ETHSEEN++;
            if (FCV_ETHSEEN > 20)
            {
              /* never completes (or larger than the 2 KB buffer): drop the client */
              FCV_ETHSEEN = 0;
              FCD_05c71_WebSocket1__Prv_CloseLink();
              FCV_ETHCLIENTCONNECTED = 3;
              wipe = 1;
            }
          }
          else
          {
            FCV_ETHSEEN = 0;
          }
        }
        if (go)
        {
          /* only hand bytes back if there were bytes to read, so a pointer left over from a peek is never written */
          commit = (rsr > 0 || FCV_05061_NetworkComms1__RXCOUNT != 0) ? 1 : 0;
          FCV_ETHCLIENTCONNECTED = FCD_05c71_WebSocket1__CheckSocketActivity();
          if (FCV_ETHCLIENTCONNECTED >= 1 && FCV_ETHCLIENTCONNECTED <= 3) { wipe = 1; }
        }
      }
    }
    else
    {
      if (sr == 0x16)
      {
        /* SYN received: the connection is still being set up, leave the socket alone */
      }
      else if (sr == 0x14)
      {
        /* Listening. Only re-create it if the port or address was just changed (CreateServerSocket sets CLOSED) */
        if (FCV_05061_NetworkComms1__CLOSED) { reopen = 1; }
      }
      else if (sr == 0x17)
      {
        if (FCV_05061_NetworkComms1__CLOSED)
        {
          reopen = 1;
        }
        else if (rsr > 0)
        {
          /* The handshake loop in the component never ends if the bytes have no CRLFCRLF in them (it keeps
             re-reading the same unreleased bytes), so only start it once a whole HTTP header has arrived */
          MX_UINT16 off = 0;
          MX_UINT16 scan = rsr;
          MX_UINT16 n;
          MX_UINT16 k;
          MX_UINT8 st = 0;
          MX_UINT8 found = 0;

          if (scan > 1024) { scan = 1024; }
          while (off < scan && found == 0)
          {
            n = scan - off;
            if (n > 20) { n = 20; }
            FCV_066a1_TCP_IP_W5500__GRXPTR[0] = rd + off;
            FCD_066a1_TCP_IP_W5500__RxReadArray(0, pk, 20, n);
            for (k = 0; k < n && found == 0; k++)
            {
              if ((st & 1) == 0) { st = (pk[k] == 13) ? st + 1 : 0; }
              else { st = (pk[k] == 10) ? st + 1 : ((pk[k] == 13) ? 1 : 0); }
              if (st == 4) { found = 1; }
            }
            off = off + n;
          }

          if (found)
          {
            FCV_ETHSEEN = 0;
            FCV_ETHIDLE = 0;
            FCV_ETHCLIENTCONNECTED = FCD_05c71_WebSocket1__CheckSocketActivity();
            commit = 1;
            wipe = 1;
          }
          else
          {
            /* header not complete yet: give it a few passes, then drop whatever this is */
            FCV_ETHSEEN++;
            if (FCV_ETHSEEN > 20 || rsr >= 1024) { reopen = 1; }
          }
        }
        else
        {
          /* Connected but silent: do not let it hold the only socket for ever */
          FCV_ETHIDLE++;
          if (FCV_ETHIDLE > 100) { reopen = 1; }
        }
      }
      else
      {
        /* CLOSED, INIT, CLOSE_WAIT, FIN_WAIT, TIME_WAIT ...: start again */
        reopen = 1;
      }

      if (reopen)
      {
        commit = 0;
        wipe = 1;
        FCD_066a1_TCP_IP_W5500__CreateTCPSocket(0, FCV_05061_NetworkComms1__PORT);
        FCD_066a1_TCP_IP_W5500__TCPListen(0);
        FCD_066a1_TCP_IP_W5500__RxFlushData(0);
        FCV_05061_NetworkComms1__CLOSED = 0;
        FCV_05061_NetworkComms1__RXCOUNT = 0;
        FCV_05061_NetworkComms1__TXDATASTART = 0;
        FCV_ETHIDLE = 0;
        FCV_ETHSEEN = 0;
      }
    }

    /* ParseJSON answers whatever message is at the front of the shared command queue, so one stale message left
       from an earlier client or frame shifts every later reply by one (a heartbeat 'version' then gets a sensor
       reading, and the Hi/COM gate sees the old message instead of the new one). Start each client and each frame
       with an empty queue; this runs before the caller copies the new frame in. */
    if (wipe)
    {
      FCD_01212_CircularBuffer1__FlushBuffer();
      FCV_COMMSSTATE = 0;
    }

    /* The W5500 driver reads received bytes through its own pointer but never tells the chip they are consumed
       (the flush in NetworkComms.Receive is disabled), so each new read would start again at the old upgrade
       request and the frame reader would decode it as garbage. Hand back exactly what has been read. */
    if (commit && FCD_05c71_WebSocket1__IsConnected())
    {
      FCD_066a1_TCP_IP_W5500__MAC_SetRegister(0);
      FCD_066a1_TCP_IP_W5500__MAC_WriteWord(FCV_066a1_TCP_IP_W5500__SN_RX_RD, FCV_066a1_TCP_IP_W5500__GRXPTR[0]);
      FCD_066a1_TCP_IP_W5500__MAC_WriteByte(FCV_066a1_TCP_IP_W5500__SN_CR, FCV_066a1_TCP_IP_W5500__SN_CR_RECV);
    }
  }
