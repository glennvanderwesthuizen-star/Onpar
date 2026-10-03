# Putting On Par online: step by step

This puts On Par on one server in Amazon's Cape Town data centre (AWS `af-south-1`), so the data stays in South Africa (POPIA). It suits testing and the pilot. You do the account and clicking steps; the server does the rest by itself.

**Time:** about an hour, most of it waiting.
**What you need:** a bank card for AWS and a phone for the security code.
**Cost (estimate, check before you start):** the server plus storage is roughly **US$40–55 a month** (about R750–R1,000). The exact price is on AWS's calculator at https://calculator.aws/ (choose Africa (Cape Town), EC2, t3.medium, 30 GB gp3). Step 1 sets a spending alert so there are no surprises.

---

## 1. Create the AWS account (15 minutes)

1. Go to https://aws.amazon.com and choose **Create an AWS Account**. Use a company email address that more than one person can reach, not a personal one.
2. Choose the **Basic (free) support plan**.
3. **Protect the account:** once signed in, open the account menu (top right), then **Security credentials**, then **Assign MFA device**. Use an authenticator app on your phone. This matters: whoever controls this account controls all On Par data.
4. **Set a spending alert:** search for **Budgets** in the top search bar, then **Create budget**. Choose the **Monthly cost budget** template, enter **60** (US dollars) and your email address.

## 2. Switch on the Cape Town region (5 minutes, then a short wait)

Cape Town is switched off by default on new accounts.

1. Account menu (top right), then **Account**, then scroll to **AWS Regions**.
2. Find **Africa (Cape Town) af-south-1** and choose **Enable**. It can take a few minutes.
3. In the region menu (top right, next to your name) choose **Africa (Cape Town)**. Keep it selected for every step below.

## 3. Create the server (15 minutes)

1. Search for **EC2**, then **Launch instance**.
2. **Name:** `onpar-server`.
3. **Operating system:** **Ubuntu**, version **Ubuntu Server 24.04 LTS**.
4. **Instance type:** **t3.medium**.
5. **Key pair:** choose **Proceed without a key pair**. You will connect through the browser instead.
6. **Network settings**, then **Edit**:
   - Keep "Allow SSH traffic", from **Anywhere**. (Not "My IP": the browser login in step 4 comes from Amazon's addresses, not yours. It stays safe because there is no key pair and no password login; only Amazon's short-lived browser keys work.)
   - Tick **Allow HTTPS traffic from the internet** and **Allow HTTP traffic from the internet**.
7. **Storage:** **30** GB, type **gp3**.
8. **Launch instance.**
9. **Give it a fixed address:** open **Elastic IPs** (left menu) and choose **Allocate Elastic IP address**, then **Allocate**. Then, with the new address selected, choose **Actions**, then **Associate**, pick `onpar-server` and choose **Associate**. Write the address down (for example `13.245.10.20`). The web address depends on it, so it must never change.

## 4. Prepare the server (10 minutes)

1. In **Instances**, select `onpar-server`, then **Connect**, then the **EC2 Instance Connect** tab, then **Connect**. A black terminal window opens in your browser.
2. Open this project on GitHub, go to the file `deploy/server-setup.sh`, and choose **Copy raw file** (the copy icon).
3. Paste it into the terminal, press Enter, and wait (a few minutes).
4. At the end it prints a line starting with `ssh-ed25519`. Copy that whole line.

## 5. Let the server fetch the code (5 minutes)

1. On GitHub, open the On Par repository, then **Settings**, then **Deploy keys**, then **Add deploy key**.
2. **Title:** `onpar-server`. **Key:** paste the line. Leave **Allow write access** unticked. **Add key.**
3. Back in the server's terminal, paste these lines one at a time:

```
newgrp docker
sudo mkdir -p /opt/onpar && sudo chown $USER /opt/onpar
git clone git@github.com:glennvanderwesthuizen-star/Onpar.git /opt/onpar
cd /opt/onpar
deploy/onpar.sh install
```

The install builds On Par on the server (about 10 minutes the first time) and starts it. It finishes by printing your web address, for example `https://13-245-10-20.sslip.io`. That free address gives a proper HTTPS padlock without buying a domain. A TSF address such as `onpar.tsf.co.za` can replace it later.

## 6. Keep the two secrets safe (5 minutes)

The install created two secrets that exist only on the server:

```
grep DATA_KEY deploy/.env
cat deploy/backup-passphrase
```

Copy both into a password manager that at least two trusted people can open (POPIA checklist item P-9). **Without the DATA_KEY, ID numbers and photos cannot be read, not even from a backup.**

## 7. First use

- **To try it with demo data:** `deploy/onpar.sh demo`, then sign in at your address with `admin@demo.onpar.local` / `OnPar-demo-2026`. Use this only for testing, and change the password on the My account page.
- **For the real company:** `deploy/onpar.sh company "TSF Security (Pty) Ltd" "Your Name" you@tsf.co.za`. It prints a temporary password once; you choose your own at first sign-in, then add your people on the **Users** page.

## 8. Daily snapshots of the whole server (5 minutes)

On Par already makes an encrypted backup every night at 02:15, kept on the server. For protection if the server itself is lost:

1. In EC2, open **Lifecycle Manager**, then **Create lifecycle policy**, then **EBS snapshot policy**.
2. **Target:** instances with the tag `Name` = `onpar-server`.
3. **Schedule:** daily. **Keep:** 7 snapshots. **Create.**

## Everyday commands (in the server's terminal, from `/opt/onpar`)

| To | Type |
|---|---|
| Get the newest version | `deploy/onpar.sh update` |
| See that everything is running | `deploy/onpar.sh status` |
| See recent messages if something is wrong | `deploy/onpar.sh logs` |
| Make a backup now | `deploy/onpar.sh backup` |
| Start again with new secrets (deletes all data; asks you to type DELETE EVERYTHING) | `deploy/onpar.sh reset` |

## Connecting the phones

On the website, **Devices**, then **Register a device** shows a QR code. Open the On Par app on the phone and scan it. The phone then talks to your server's address. The app file for the phone is on GitHub: **Actions**, then the latest successful run, then **onpar-phone-app**.
