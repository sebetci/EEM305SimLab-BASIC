; ============================================================
; EEM305 - Dizi işlemleri örnek programı
; 30h-37h adreslerindeki 8 elemanlı dizi üzerinde:
;   toplam, en büyük eleman, tek sayıların adedi,
;   ardışık toplama ile çarpma ve P1'de kayan LED deseni.
; Sonuçlar:
;   40h = toplam (düşük byte)    41h = toplam (yüksek byte)
;   42h = en büyük eleman        43h = tek sayıların adedi
;   44h = 07h x 06h              P1  = desen ve toplam
; ============================================================

        ORG   0000h
        LJMP  Main              ; kesme vektörlerini atla

        ORG   0030h
Main:   MOV   SP,#4Fh           ; stack 50h'den itibaren büyür
        LCALL Temizle           ; dizi ve sonuç alanını sıfırla
        LCALL Doldur            ; diziye değerleri yaz
        LCALL Topla             ; 16 bit toplam -> 40h, 41h
        LCALL EnBuyuk           ; en büyük eleman -> 42h
        LCALL TekSay            ; tek sayı adedi -> 43h
        LCALL Carp              ; 07h x 06h -> 44h
        LCALL Desen             ; P1 üzerinde kayan bit
Son:    SJMP  Son               ; programın sonu

; ---- 30h-37h ve 40h-44h alanını sıfırla ----
Temizle:
        MOV   R0,#30h           ; R0 = dizinin başlangıç adresi
        MOV   R2,#08h           ; R2 = eleman sayısı (sayaç)
        CLR   A
Tmz1:   MOV   @R0,A             ; RAM[R0] <- 0
        INC   R0
        DJNZ  R2,Tmz1           ; 8 kez tekrarla
        MOV   40h,A
        MOV   41h,A
        MOV   42h,A
        MOV   43h,A
        MOV   44h,A
        RET

; ---- Diziyi doldur ----
Doldur: MOV   30h,#12h
        MOV   31h,#7Fh
        MOV   32h,#3Ch
        MOV   33h,#0A5h
        MOV   34h,#56h
        MOV   35h,#0E1h
        MOV   36h,#08h
        MOV   37h,#99h
        RET

; ---- 16 bit toplam: R7:R6 ----
Topla:  MOV   R0,#30h
        MOV   R2,#08h
        MOV   R6,#00h           ; toplamın düşük byte'ı
        MOV   R7,#00h           ; toplamın yüksek byte'ı
Top1:   MOV   A,@R0             ; A <- dizi elemanı
        ADD   A,R6              ; A <- A + R6 (taşma CY'ye)
        MOV   R6,A
        MOV   A,R7
        ADDC  A,#00h            ; elde varsa yüksek byte'a ekle
        MOV   R7,A
        INC   R0
        DJNZ  R2,Top1
        MOV   40h,R6
        MOV   41h,R7
        RET

; ---- En büyük eleman: R5 ----
EnBuyuk:
        MOV   R0,#30h
        MOV   R2,#08h
        MOV   R5,#00h           ; şimdiye kadarki en büyük
Eb1:    MOV   A,@R0
        CLR   C
        SUBB  A,R5              ; A - R5; borç (CY=1) varsa eleman küçük
        JC    Eb2
        MOV   A,@R0
        MOV   R5,A              ; yeni en büyük
Eb2:    INC   R0
        DJNZ  R2,Eb1
        MOV   42h,R5
        RET

; ---- Tek sayıları say: R4 ----
TekSay: MOV   R0,#30h
        MOV   R2,#08h
        MOV   R4,#00h
Tk1:    MOV   A,@R0
        ANL   A,#01h            ; en düşük bit 1 ise sayı tektir
        JZ    Tk2
        INC   R4
Tk2:    INC   R0
        DJNZ  R2,Tk1
        MOV   43h,R4
        RET

; ---- Çarpma: 07h x 06h = ardışık toplama ----
Carp:   PUSH  ACC               ; A'yı stack'e sakla
        MOV   R2,#07h           ; çarpılan
        MOV   R3,#06h           ; çarpan (döngü sayacı)
        CLR   A
Crp1:   ADD   A,R2              ; A <- A + 7, 6 kez
        DJNZ  R3,Crp1
        MOV   44h,A
        POP   ACC               ; A'yı geri al
        RET

; ---- P1'de kayan bit, sonra toplamın tersi ----
Desen:  MOV   A,#01h
        MOV   R2,#08h
Ds1:    MOV   P1,A              ; LED deseni P1'e
        RL    A                 ; bir bit sola döndür
        DJNZ  R2,Ds1
        MOV   A,40h             ; toplamın düşük byte'ı
        CPL   A                 ; LED'ler aktif-düşük
        MOV   P1,A
        RET

        END
